    const DEFAULT_VENDORS = [
      'Darpan Printer',
      'Gyan Digital',
      'Aydee Offset',
      'Maharaja Agrasen Printing Press',
      'Kamal Printer (Manish Lamination)'
    ];
    const STOCK_LOCATIONS = ['Printzone', 'Darpan', 'Gyan', 'Kapil', 'Other'];
    const DEFAULT_STATE = {
      parties: [],
      vendors: DEFAULT_VENDORS.map(name => ({
        name, role: 'Printing', prefix: '', challanSequence: 0
      })),
      challans: [],
      orders: [],
      paperStock: {},
      paperAdded: {},
      paperSent: {},
      paperMeta: {},
      paperLocations: {},
      stockFlow: [],
      tallyRows: [],
      activities: []
    };

    let state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    let pipelineChartInst = null;
    let stockChartInst = null;
    let stateSaveQueue = Promise.resolve();
    let stateRevision = 0;
    let lastSyncedState = JSON.parse(JSON.stringify(DEFAULT_STATE));
    let stateSaveInProgress = false;
    let stateHasUnsavedChanges = false;
    let stateSyncBlocked = false;
    let stateSyncTimer = null;
    let pendingFilter = 'active';
    let dispatchFilter = 'all';
    let challanPartyFilter = 'all';
    let challanVendorFilter = 'all';
    let vendorPartyFilter = 'all';
    let vendorFilter = 'all';
    const THEME_KEY = 'printzone_theme';

    window.getInitialState = () => JSON.parse(JSON.stringify(DEFAULT_STATE));
    window.setAppState = (nextState, revision) => {
      state = { ...JSON.parse(JSON.stringify(DEFAULT_STATE)), ...nextState };
      stateRevision = Number.isInteger(revision) ? revision : null;
      lastSyncedState = JSON.parse(JSON.stringify(state));
      stateHasUnsavedChanges = false;
      stateSyncBlocked = stateRevision === null;
      state.vendors = state.vendors || [];
      if (window.printzoneUser?.role !== 'Accountant') {
        DEFAULT_VENDORS.forEach(name => {
          if (!state.vendors.some(vendor => vendor.name.toLowerCase() === name.toLowerCase())) {
            state.vendors.push({ name, role: 'Printing', prefix: getVendorPrefix(name), challanSequence: 0 });
          }
        });
      }
      Object.keys(state.paperStock || {}).forEach(sku => {
        state.paperMeta[sku] = state.paperMeta[sku] || {
          paperType: sku, paperSize: '', gsm: 0
        };
        state.paperLocations[sku] = state.paperLocations[sku] || {};
        if (state.paperLocations[sku].Printzone === undefined) {
          state.paperLocations[sku].Printzone = Number(state.paperStock[sku] || 0);
        }
      });
      state.orders.forEach(order => {
        order.approvalStatus = order.approvalStatus || 'Approved';
        order.prod = {
          receivedFromVendor: false,
          lamination: false,
          laminationSkipped: false,
          cutting: false,
          pasting: false,
          ready: false,
          ...(order.prod || {})
        };
      });
      renderAll();
      if (stateSyncBlocked) {
        setSyncStatus('offline', 'Restart the app server to enable saving');
      }
      startStateSync();
    };

    function stateValueEqual(left, right) {
      return JSON.stringify(left) === JSON.stringify(right);
    }

    function mergeStateProperty(baseExists, baseValue, localExists, localValue, remoteExists, remoteValue, path) {
      const localUnchanged = baseExists === localExists
        && (!baseExists || stateValueEqual(baseValue, localValue));
      const remoteUnchanged = baseExists === remoteExists
        && (!baseExists || stateValueEqual(baseValue, remoteValue));
      if (localUnchanged) return { exists: remoteExists, value: remoteValue };
      if (remoteUnchanged) return { exists: localExists, value: localValue };
      if (localExists === remoteExists && (!localExists || stateValueEqual(localValue, remoteValue))) {
        return { exists: localExists, value: localValue };
      }
      if (!localExists || !remoteExists) {
        throw new Error(`Concurrent delete/update conflict in ${path}.`);
      }
      return {
        exists: true,
        value: mergeStateValue(baseExists ? baseValue : undefined, localValue, remoteValue, path)
      };
    }

    function mergeRecordArray(base, local, remote, path) {
      const identityField = path === 'vendors' ? 'name' : 'id';
      const toMap = items => new Map(items.map(item => [String(item[identityField]), item]));
      const baseMap = toMap(base);
      const localMap = toMap(local);
      const remoteMap = toMap(remote);
      const keys = [...remoteMap.keys(), ...localMap.keys(), ...baseMap.keys()];
      const seen = new Set();
      const result = [];
      keys.forEach(key => {
        if (seen.has(key)) return;
        seen.add(key);
        const merged = mergeStateProperty(
          baseMap.has(key), baseMap.get(key),
          localMap.has(key), localMap.get(key),
          remoteMap.has(key), remoteMap.get(key),
          `${path}.${key}`
        );
        if (merged.exists) result.push(merged.value);
      });
      return result;
    }

    function mergeAppendOnlyArray(base, local, remote, path) {
      if (
        base.some(item => !local.some(candidate => stateValueEqual(item, candidate)))
        || base.some(item => !remote.some(candidate => stateValueEqual(item, candidate)))
      ) {
        throw new Error(`Concurrent history conflict in ${path}.`);
      }
      const result = [...remote];
      local.forEach(item => {
        if (!result.some(candidate => stateValueEqual(item, candidate))) result.push(item);
      });
      return path === 'activities' ? result.slice(0, 10) : result;
    }

    function mergeStateValue(base, local, remote, path) {
      if (
        ['paperStock', 'paperAdded', 'paperSent', 'paperMeta', 'paperLocations'].includes(path)
        && !stateValueEqual(local, base) && !stateValueEqual(remote, base)
      ) {
        throw new Error('Concurrent paper stock changes require a fresh balance.');
      }
      if (stateValueEqual(local, base)) return remote;
      if (stateValueEqual(remote, base)) return local;
      if (stateValueEqual(local, remote)) return local;
      if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
        if (['orders', 'parties', 'vendors', 'challans'].includes(path)) {
          return mergeRecordArray(base, local, remote, path);
        }
        if (['activities', 'stockFlow'].includes(path)) {
          return mergeAppendOnlyArray(base, local, remote, path);
        }
        throw new Error(`Concurrent list update conflict in ${path}.`);
      }
      if (
        base && local && remote
        && typeof base === 'object' && typeof local === 'object' && typeof remote === 'object'
        && !Array.isArray(base) && !Array.isArray(local) && !Array.isArray(remote)
      ) {
        const result = {};
        const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
        keys.forEach(key => {
          const merged = mergeStateProperty(
            Object.prototype.hasOwnProperty.call(base, key), base[key],
            Object.prototype.hasOwnProperty.call(local, key), local[key],
            Object.prototype.hasOwnProperty.call(remote, key), remote[key],
            path ? `${path}.${key}` : key
          );
          if (merged.exists) result[key] = merged.value;
        });
        return result;
      }
      throw new Error(`Concurrent update conflict in ${path}.`);
    }

    function setSyncStatus(status, message) {
      const indicator = document.getElementById('syncStatus');
      const label = document.getElementById('syncStatusText');
      if (!indicator || !label) return;
      indicator.dataset.state = status;
      label.textContent = message;
      const reloadButton = document.getElementById('syncReloadBtn');
      if (reloadButton) {
        reloadButton.classList.toggle(
          'hidden',
          !stateSyncBlocked || stateRevision === null
        );
      }
    }

    function stateForPersistence(source) {
      const snapshot = JSON.parse(JSON.stringify(source));
      if (window.printzoneUser?.role === 'Accountant') {
        snapshot.parties = [];
        snapshot.activities = [];
      }
      return snapshot;
    }

    async function readLatestState() {
      const response = await fetch('/api/state', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to refresh workspace data.');
      return result;
    }

    window.reloadWorkspaceFromServer = async () => {
      try {
        const latest = await readLatestState();
        if (!Number.isInteger(latest.version)) {
          stateSyncBlocked = true;
          setSyncStatus('offline', 'Restart the app server to enable saving');
          return;
        }
        window.setAppState(latest.data, latest.version);
        setSyncStatus('saved', 'Latest team changes loaded');
      } catch (error) {
        setSyncStatus('offline', 'Could not load the latest changes');
        showToast(error.message, 'rose');
      }
    };

    async function refreshWorkspace() {
      if (
        !window.printzoneUser || document.visibilityState === 'hidden'
        || stateSaveInProgress || stateHasUnsavedChanges || stateSyncBlocked
      ) return;
      try {
        const latest = await readLatestState();
        if (!Number.isInteger(latest.version)) {
          stateSyncBlocked = true;
          setSyncStatus('offline', 'Restart the app server to enable live updates');
          return;
        }
        if (
          latest.version > stateRevision && !stateSaveInProgress
          && !stateHasUnsavedChanges && !stateSyncBlocked
        ) {
          window.setAppState(latest.data, latest.version);
          setSyncStatus('saved', 'Updated with the latest team changes');
        } else if (latest.version === stateRevision) {
          setSyncStatus('saved', 'Live · All changes saved');
        }
      } catch (error) {
        setSyncStatus('offline', 'Connection interrupted · retrying');
      }
    }

    function startStateSync() {
      if (stateSyncTimer) return;
      stateSyncTimer = setInterval(refreshWorkspace, 3000);
      window.addEventListener('online', () => {
        if (stateHasUnsavedChanges) saveState();
        refreshWorkspace();
      });
      window.addEventListener('focus', refreshWorkspace);
    }

    function applyTheme(theme) {
      const isLight = theme === 'light';
      document.body.classList.toggle('light-theme', isLight);
      const lbl = document.getElementById('themeToggleLabel');
      if (lbl) lbl.textContent = isLight ? 'Switch to Dark Theme' : 'Switch to Light Theme';
      const icon = document.getElementById('themeToggleIcon');
      if (icon) {
        const replacement = document.createElement('i');
        replacement.id = 'themeToggleIcon';
        replacement.dataset.lucide = isLight ? 'moon' : 'sun';
        replacement.className = 'w-4 h-4 text-amber-300';
        replacement.setAttribute('aria-hidden', 'true');
        icon.replaceWith(replacement);
      }
      try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
    }

    window.toggleTheme = () => {
      const next = document.body.classList.contains('light-theme') ? 'dark' : 'light';
      applyTheme(next);
      renderAll();
    };

    try { applyTheme(localStorage.getItem(THEME_KEY) || 'light'); } catch (e) {}

    function saveState() {
      if (!window.printzoneUser) return;
      stateHasUnsavedChanges = true;
      if (stateRevision === null) {
        stateSyncBlocked = true;
        setSyncStatus('offline', 'Restart the app server to enable saving');
        showToast('Please restart the app server before saving; refresh after it restarts.', 'rose');
        return;
      }
      if (stateSaveInProgress || stateSyncBlocked) return;
      stateSaveInProgress = true;
      stateSaveQueue = (async () => {
        try {
          while (stateHasUnsavedChanges && !stateSyncBlocked) {
            stateHasUnsavedChanges = false;
            let snapshot = stateForPersistence(state);
            setSyncStatus('saving', 'Saving team changes…');
            let response = await fetch('/api/state', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ version: stateRevision, data: snapshot })
            });
            let result = await response.json();
            if (response.status === 409 && result.conflict) {
              try {
                snapshot = mergeStateValue(
                  lastSyncedState,
                  stateForPersistence(state),
                  result.data,
                  ''
                );
              } catch (mergeError) {
                stateSyncBlocked = true;
                stateHasUnsavedChanges = true;
                setSyncStatus('conflict', 'Another user changed the same data');
                showToast(
                  'A teammate changed the same record. Reload the latest data before saving again.',
                  'rose'
                );
                return;
              }
              stateRevision = result.version;
              lastSyncedState = JSON.parse(JSON.stringify(result.data));
              state = snapshot;
              renderAll();
              stateHasUnsavedChanges = true;
              response = await fetch('/api/state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ version: stateRevision, data: snapshot })
              });
              result = await response.json();
            }
            if (!response.ok) {
              throw new Error(result.error || 'Unable to save workspace data.');
            }
            stateRevision = result.version;
            lastSyncedState = snapshot;
            setSyncStatus('saved', 'Live · All changes saved');
          }
        } catch (error) {
          stateHasUnsavedChanges = true;
          setSyncStatus('offline', 'Save failed · your changes are still on this screen');
          showToast(`Save failed: ${error.message}`, 'rose');
        } finally {
          stateSaveInProgress = false;
        }
      })();
    }
    function logActivity(text) { state.activities.unshift(text); if (state.activities.length > 10) state.activities.pop(); }
    function updateFilterOptions(selectId, allLabel, entries, selectedValue) {
      const select = document.getElementById(selectId);
      if (!select) return;
      const options = [{ value: 'all', label: allLabel }, ...entries];
      select.innerHTML = options.map(option =>
        `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`
      ).join('');
      select.value = options.some(option => option.value === selectedValue)
        ? selectedValue
        : 'all';
    }

    window.setChallanFilter = (filter, value) => {
      if (filter === 'party') challanPartyFilter = value;
      if (filter === 'vendor') challanVendorFilter = value;
      renderAll();
    };

    window.setVendorFilter = (filter, value) => {
      if (filter === 'party') vendorPartyFilter = value;
      if (filter === 'vendor') vendorFilter = value;
      renderAll();
    };

    function showToast(msg, tone = 'indigo') {
      const container = document.getElementById('toastContainer');
      const colors = {
        indigo: 'bg-[#090d24] text-white border-pink-500',
        emerald: 'bg-emerald-700 text-white border-emerald-400',
        rose: 'bg-rose-700 text-white border-rose-400',
        amber: 'bg-amber-600 text-white border-amber-300'
      };
      const el = document.createElement('div');
      el.className = `pointer-events-auto px-4 py-2.5 rounded-xl border-l-4 shadow-lg text-sm font-bold ${colors[tone] || colors.indigo}`;
      el.textContent = msg;
      container.appendChild(el);
      setTimeout(() => el.remove(), 3200);
    }

    function getVendorPrefix(vendor) {
      const found = state.vendors.find(v => v.name.toLowerCase() === vendor.toLowerCase());
      if (found && found.prefix) return found.prefix;
      const base = vendor.replace(/[^A-Za-z]/g, '').slice(0, 5).toUpperCase() || 'VEN';
      const used = new Set(state.vendors
        .filter(item => item.name.toLowerCase() !== vendor.toLowerCase())
        .map(item => String(item.prefix || '').toUpperCase()));
      let code = base;
      let suffix = 2;
      while (used.has(code)) code = `${base.slice(0, 4)}${suffix++}`;
      return code;
    }

    function escapeHtml(value) {
      return String(value || '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[char]));
    }

    function paperSku(paperType, paperSize, gsm) {
      return [paperType.trim(), paperSize.trim(), Number(gsm)].join(' | ');
    }

    function locationForVendor(vendor) {
      const name = String(vendor || '').toLowerCase();
      if (name.includes('darpan')) return 'Darpan';
      if (name.includes('gyan')) return 'Gyan';
      if (name.includes('kapil')) return 'Kapil';
      return 'Other';
    }

    function paperLocationBalance(sku, location) {
      const stock = state.paperLocations[sku] || {};
      if (location === 'Printzone' && stock.Printzone === undefined) {
        return Number(state.paperStock[sku] || 0);
      }
      return Number(stock[location] || 0);
    }

    function setPaperLocationBalance(sku, location, quantity) {
      state.paperLocations[sku] = state.paperLocations[sku] || {};
      state.paperLocations[sku][location] = quantity;
      if (location === 'Printzone') state.paperStock[sku] = quantity;
    }

    function movePaper({ sku, from, to, quantity, challanNo, note, type }) {
      const available = paperLocationBalance(sku, from);
      if (quantity <= 0 || available < quantity) return false;
      setPaperLocationBalance(sku, from, available - quantity);
      setPaperLocationBalance(
        sku, to, paperLocationBalance(sku, to) + quantity
      );
      if (from === 'Printzone') {
        state.paperSent[sku] = Number(state.paperSent[sku] || 0) + quantity;
      }
      const meta = state.paperMeta[sku] || {};
      state.stockFlow.unshift({
        type: type || 'TRANSFER',
        paperType: meta.paperType || sku,
        paperSize: meta.paperSize || '',
        gsm: Number(meta.gsm || 0),
        qty: type === 'RECEIVED' ? quantity : -quantity,
        note,
        sku,
        from,
        to,
        challanNo: challanNo || '-',
        balanceAfter: paperLocationBalance(sku, from),
        date: new Date().toISOString().slice(0, 10)
      });
      return true;
    }

    function nextChallanIdForVendor() {
      const year = new Date().getFullYear();
      const pattern = new RegExp(`^CH-${year}-(\\d+)$`, 'i');
      const lastUsed = state.challans.reduce((max, challan) => {
        const match = String(challan.id).match(pattern);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0);
      return `CH-${year}-${String(lastUsed + 1).padStart(4, '0')}`;
    }

    function populateVendorOptions() {
      ['chVendorSelect', 'forwardVendorSelect'].forEach(id => {
        const select = document.getElementById(id);
        const selected = select.value;
        select.textContent = '';

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select vendor';
        placeholder.disabled = true;
        placeholder.selected = true;
        select.appendChild(placeholder);

        state.vendors.forEach(vendor => {
          const option = document.createElement('option');
          option.value = vendor.name;
          option.textContent = vendor.prefix
            ? `${vendor.name} (${vendor.prefix}-xx)`
            : vendor.name;
          select.appendChild(option);
        });

        const manualOption = document.createElement('option');
        manualOption.value = '__manual__';
        manualOption.textContent = 'Other (Type Manually)';
        select.appendChild(manualOption);

        if (Array.from(select.options).some(option => option.value === selected)) {
          select.value = selected;
        }
      });
      ['sendVendor', 'sendPaperBy', 'receivePaperVendor'].forEach(id => {
        const select = document.getElementById(id);
        if (!select) return;
        const selected = select.value;
        select.innerHTML = '<option value="">Select vendor</option>' + state.vendors.map(vendor =>
          `<option value="${escapeHtml(vendor.name)}">${escapeHtml(vendor.name)}</option>`
        ).join('');
        if (state.vendors.some(vendor => vendor.name === selected)) select.value = selected;
      });
    }

    window.selectPaperSku = selectId => {
      const sku = document.getElementById(selectId).value;
      const meta = state.paperMeta[sku] || {};
      const prefix = selectId === 'sendPaperType' ? 'send' : 'receive';
      document.getElementById(`${prefix}PaperSize`).value = meta.paperSize || '';
      document.getElementById(`${prefix}PaperGsm`).value = meta.gsm || '';
    };

    window.selectChallanForPaper = formType => {
      const receive = formType === 'receive';
      const challanId = document.getElementById(
        receive ? 'receivePaperChallan' : 'sendChallan'
      ).value;
      const challan = state.challans.find(item => item.id === challanId);
      if (!challan) return;
      const prefix = receive ? 'receive' : 'send';
      const vendorSelect = document.getElementById(
        receive ? 'receivePaperVendor' : 'sendVendor'
      );
      if (state.vendors.some(vendor => vendor.name === challan.vendor)) {
        vendorSelect.value = challan.vendor;
      }
      const sku = paperSku(challan.paperType || '', challan.paperSize || '', challan.gsm || 0);
      if (state.paperMeta[sku]) {
        const typeSelect = document.getElementById(`${prefix}PaperType`);
        typeSelect.value = sku;
        selectPaperSku(`${prefix}PaperType`);
      }
      if (!receive) {
        document.getElementById('sendPaperQty').value = challan.paperQty || '';
      }
    };

    window.navTo = (sec) => {
      const btn = document.querySelector(`.nav-btn[data-section="${sec}"]`);
      if (btn) btn.click();
    };

    window.toggleSidebarCollapsed = () => {
      const sidebar = document.getElementById('sidebar');
      const button = document.getElementById('sidebarCollapseBtn');
      const collapsed = sidebar.classList.toggle('sidebar-collapsed');
      button.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
      button.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
      button.innerHTML = `<i data-lucide="${collapsed ? 'panel-left-open' : 'panel-left-close'}"></i>`;
      document.querySelectorAll('.nav-btn').forEach(navButton => {
        const label = navButton.querySelector('span:not(.nav-count):not(.nav-quick)');
        navButton.title = label ? label.textContent.trim() : navButton.getAttribute('aria-label') || '';
      });
      if (window.lucide) window.lucide.createIcons();
    };

    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-section');
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-section') === target));
        document.querySelectorAll('.section-view').forEach(sec => sec.classList.remove('active'));
        document.getElementById(`sec-${target}`).classList.add('active');
        if (window.innerWidth < 1024) document.getElementById('sidebar').classList.add('hidden');
        renderAll();
      });
    });

    window.setPendingFilter = filter => {
      pendingFilter = filter;
      document.querySelectorAll('.job-filter-btn').forEach(button => {
        button.classList.toggle('active', button.dataset.jobFilter === filter);
      });
      renderAll();
    };

    window.setDispatchFilter = filter => {
      dispatchFilter = filter;
      document.querySelectorAll('.dispatch-filter-btn').forEach(button => {
        const active = button.dataset.dispatchFilter === filter;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      renderAll();
    };

    document.getElementById('mobileMenuBtn').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('hidden');
    });

    window.openQuickActions = () => {
      document.getElementById('quickActionsMenu').classList.toggle('hidden');
    };

    window.quickAction = (action) => {
      document.getElementById('quickActionsMenu').classList.add('hidden');
      if (action === 'order') navTo('party-order');
      if (action === 'challan') {
        navTo('challan');
        switchChallanTab('add');
      }
      if (action === 'vendor') {
        navTo('vendor');
        document.getElementById('newVendorName').focus();
      }
    };

    window.openLoginIntro = () => document.getElementById('loginOverlay').classList.remove('hidden');

    window.switchPartyOrderTab = (tab) => {
      const orderPanel = document.getElementById('orderPanel');
      const partyPanel = document.getElementById('partyPanel');
      const bO = document.getElementById('tabCreateOrderBtn');
      const bP = document.getElementById('tabCreatePartyBtn');
      if (tab === 'party') {
        orderPanel.classList.add('hidden');
        partyPanel.classList.remove('hidden');
        bP.className = 'px-4 py-2 rounded-lg text-xs font-extrabold bg-cyan-600 text-white shadow-sm transition';
        bO.className = 'px-4 py-2 rounded-lg text-xs font-extrabold text-slate-300 hover:text-white transition';
      } else {
        partyPanel.classList.add('hidden');
        orderPanel.classList.remove('hidden');
        bO.className = 'px-4 py-2 rounded-lg text-xs font-extrabold bg-pink-600 text-white shadow-sm transition';
        bP.className = 'px-4 py-2 rounded-lg text-xs font-extrabold text-slate-300 hover:text-white transition';
      }
    };

    window.switchChallanTab = (tab) => {
      const lP = document.getElementById('challanListPanel');
      const aP = document.getElementById('challanAddPanel');
      const bL = document.getElementById('tabChallanListBtn');
      const bA = document.getElementById('tabAddChallanBtn');
      if (tab === 'add') {
        lP.classList.add('hidden');
        aP.classList.remove('hidden');
        bA.className = 'px-4 py-2 rounded-lg text-xs font-extrabold bg-cyan-600 text-white transition';
        bL.className = 'px-4 py-2 rounded-lg text-xs font-extrabold text-slate-300 hover:text-white transition';
      } else {
        aP.classList.add('hidden');
        lP.classList.remove('hidden');
        bL.className = 'px-4 py-2 rounded-lg text-xs font-extrabold bg-cyan-600 text-white transition';
        bA.className = 'px-4 py-2 rounded-lg text-xs font-extrabold text-slate-300 hover:text-white transition';
      }
    };

    window.updateChallanPreview = () => {
      const selectedJobs = new Set(
        Array.from(document.querySelectorAll('#challanEligibleJobs input[type="checkbox"]:checked'))
          .map(input => input.value)
      );
      const eligibleJobs = state.orders.filter(order =>
        order.approvalStatus === 'Approved'
        && order.printingStatus === 'Done' && !order.challanNo && order.stage === 'pending'
      );
      const jobsContainer = document.getElementById('challanEligibleJobs');
      if (jobsContainer) {
        jobsContainer.innerHTML = eligibleJobs.length
          ? eligibleJobs.map(order => `
          <label class="flex items-start gap-2 rounded-lg border border-white/10 bg-white/5 p-2 text-xs">
            <input type="checkbox" value="${escapeHtml(order.id)}" ${selectedJobs.has(order.id) ? 'checked' : ''} class="mt-0.5" />
            <span class="min-w-0"><strong class="text-white">${escapeHtml(order.id)} · ${escapeHtml(order.name)}</strong><span class="block text-slate-400">${escapeHtml(order.partyName)} · ${escapeHtml(order.size)} · ${Number(order.qty || 0).toLocaleString()} · ${escapeHtml(order.jobType)}</span></span>
          </label>
        `).join('')
          : '<p class="col-span-full py-3 text-center text-xs text-slate-400">No unassigned design-completed jobs.</p>';
      }

      const sel = document.getElementById('chVendorSelect').value;
      const isManual = sel === '__manual__';
      document.getElementById('chVendorManualWrap').classList.toggle('hidden', !isManual);
      document.getElementById('chVendorManual').required = isManual;
      if (!sel) {
        document.getElementById('nextChPreviewId').textContent = '—';
        document.getElementById('autoFetchProductsPreview').textContent = 'Select a vendor to continue';
        document.getElementById('chVendorStockPreview').textContent = 'Available Stock at Vendor: —';
        return;
      }
      const vName = isManual ? (document.getElementById('chVendorManual').value.trim() || 'Vendor') : sel;
      const nextId = nextChallanIdForVendor(vName);
      document.getElementById('nextChPreviewId').textContent = nextId;
      const paperType = document.getElementById('chPaperType').value.trim();
      const paperSize = document.getElementById('chPaperSize').value.trim();
      const gsm = Number(document.getElementById('chGsm').value);
      const vendorStockPreview = document.getElementById('chVendorStockPreview');
      if (paperType && paperSize && gsm > 0) {
        const sku = paperSku(paperType, paperSize, gsm);
        const available = paperLocationBalance(sku, locationForVendor(vName));
        vendorStockPreview.textContent =
          `Available Stock at Vendor (${locationForVendor(vName)}): ${available.toLocaleString()} sheets`;
      } else {
        vendorStockPreview.textContent = 'Available Stock at Vendor: Enter paper type, size, and GSM';
      }
      const matched = state.orders.filter(o =>
        o.challanNo === nextId
        || (o.approvalStatus === 'Approved' && o.printingStatus === 'Done' && !o.challanNo && o.stage === 'pending')
      );
      document.getElementById('autoFetchProductsPreview').textContent = matched.length
        ? `${matched.length} design-completed job(s) are available to select below`
        : 'No unassigned design-completed jobs yet';
    };

    window.toggleForwardManual = () => {
      const isManual = document.getElementById('forwardVendorSelect').value === '__manual__';
      document.getElementById('forwardManualWrap').classList.toggle('hidden', !isManual);
      document.getElementById('forwardManualInput').required = isManual;
    };

    // Form Submissions
    document.getElementById('partyForm').addEventListener('submit', e => {
      e.preventDefault();
      const name = document.getElementById('partyName').value.trim();
      const mobile = document.getElementById('partyMobile').value.trim();
      const gmail = document.getElementById('partyGmail').value.trim();
      if (!name) return;
      const nextPartyNumber = state.parties.reduce((highest, party) =>
        Math.max(highest, Number(String(party.id || '').match(/\d+$/)?.[0] || 0)), 0
      ) + 1;
      state.parties.push({ id: `PTY-${String(nextPartyNumber).padStart(2, '0')}`, name, mobile, gmail });
      logActivity(`Party created: ${name}`);
      saveState();
      e.target.reset();
      renderAll();
      showToast(`Party "${name}" saved.`, 'emerald');
    });

    document.getElementById('orderForm').addEventListener('submit', e => {
      e.preventDefault();
      const partyId = document.getElementById('orderParty').value;
      const party = state.parties.find(p => p.id === partyId);
      const name = document.getElementById('orderName').value.trim();
      const qty = parseInt(document.getElementById('orderQty').value, 10) || 0;
      const size = document.getElementById('orderSize').value.trim();
      const printingType = document.getElementById('orderPrintType').value;
      const jobType = document.getElementById('orderJobType').value;
      if (!party || !name || qty <= 0) return;
      const nextOrderNumber = state.orders.reduce((highest, order) =>
        Math.max(highest, Number(String(order.id || '').match(/\d+$/)?.[0] || 0)), 0
      ) + 1;
      const id = `ORD-${String(nextOrderNumber).padStart(3, '0')}`;
      state.orders.push({
        id, partyId: party.id, partyName: party.name, name, qty, size, printingType, jobType,
        approvalStatus: 'Pending Approval',
        printingStatus: 'Pending', challanNo: '', vendor: '', stage: 'pending',
        prod: { receivedFromVendor: false, lamination: false, cutting: false, pasting: false, ready: false },
        dispatch: { date: '', rate: 0, status: 'Ready', productImg: '', biltyImg: '' }
      });
      logActivity(`Order ${id} (${name}) created for ${party.name}`);
      saveState();
      e.target.reset();
      renderAll();
      showToast(`Order ${id} added to Pending Approval.`, 'indigo');
    });

    window.approveOrder = orderId => {
      if (!['Admin', 'Manager'].includes(window.printzoneUser?.role)) {
        showToast('Only an administrator or manager can give final approval.', 'amber');
        return;
      }
      const order = state.orders.find(item => item.id === orderId);
      if (!order || order.approvalStatus !== 'Pending Approval') return;
      order.approvalStatus = 'Approved';
      logActivity(`Order ${order.id} approved`);
      saveState();
      renderAll();
      showToast(`Order ${order.id} moved to Pending Order.`, 'emerald');
    };

    window.toggleChallanQualityManual = () => {
      const manual = document.getElementById('chQuality').value === 'Other';
      document.getElementById('chQualityManualWrap').classList.toggle('hidden', !manual);
      document.getElementById('chQualityManual').required = manual;
    };

    window.toggleChallanSentByManual = () => {
      const manual = document.getElementById('chPaperSentBy').value === 'Other';
      document.getElementById('chPaperSentByManualWrap').classList.toggle('hidden', !manual);
      document.getElementById('chPaperSentByManual').required = manual;
    };

    document.getElementById('challanForm').addEventListener('submit', e => {
      e.preventDefault();
      const sel = document.getElementById('chVendorSelect').value;
      const vendor = sel === '__manual__' ? document.getElementById('chVendorManual').value.trim() : sel;
      const paperType = document.getElementById('chPaperType').value.trim();
      const paperSize = document.getElementById('chPaperSize').value.trim();
      const jobType = document.getElementById('chJobType').value;
      const gsm = parseInt(document.getElementById('chGsm').value, 10) || 0;
      const paperQty = parseInt(document.getElementById('chPaperQty').value, 10) || 0;
      const qualitySelect = document.getElementById('chQuality').value;
      const quality = qualitySelect === 'Other'
        ? document.getElementById('chQualityManual').value.trim()
        : qualitySelect;
      const sentBySelect = document.getElementById('chPaperSentBy').value;
      const paperSentBy = sentBySelect === 'Other'
        ? document.getElementById('chPaperSentByManual').value.trim()
        : sentBySelect;
      if (!vendor || !jobType || !paperType || !paperSize || gsm <= 0 || paperQty <= 0 || !quality || !paperSentBy) return;

      const selectedJobIds = Array.from(
        document.querySelectorAll('#challanEligibleJobs input[type="checkbox"]:checked')
      ).map(input => input.value);
      const selectedJobs = selectedJobIds.map(jobId =>
        state.orders.find(order => order.id === jobId)
      );
      if (selectedJobs.some(order =>
        !order || order.printingStatus !== 'Done' || order.challanNo || order.stage !== 'pending'
      )) {
        showToast('One or more selected jobs are no longer available for assignment.', 'amber');
        renderAll();
        return;
      }

      const id = nextChallanIdForVendor(vendor);
      if (state.challans.some(challan => challan.id === id)) {
        showToast('A challan with this number already exists. Refresh and try again.', 'rose');
        return;
      }
      let vendorRecord = state.vendors.find(item => item.name.toLowerCase() === vendor.toLowerCase());
      if (!vendorRecord) {
        vendorRecord = { name: vendor, role: 'Custom Printing Vendor', prefix: getVendorPrefix(vendor), challanSequence: 0 };
        state.vendors.push(vendorRecord);
      }
      const createdDate = new Date().toISOString().slice(0, 10);
      state.challans.push({
        id, challanDate: createdDate, sentDate: '', receivedDate: '', vendor,
        paperType, paperSize, gsm, paperQty, jobType, quality, paperSentBy,
        receivedFromVendor: false, status: selectedJobs.length ? `Created (${vendor})` : `Draft (${vendor})`,
        history: [`Created for ${vendor} on ${createdDate}`]
      });
      selectedJobs.forEach(order => {
        order.printingStatus = 'Done';
        order.challanNo = id;
        order.vendor = vendor;
      });
      logActivity(`Challan ${id} created for ${vendor}`);
      if (selectedJobs.length) {
        logActivity(`${selectedJobs.length} completed job(s) assigned to ${id}`);
      }
      saveState();
      e.target.reset();
      document.getElementById('chVendorManualWrap').classList.add('hidden');
      document.getElementById('chQualityManualWrap').classList.add('hidden');
      document.getElementById('chPaperSentByManualWrap').classList.add('hidden');
      toggleChallanQualityManual();
      toggleChallanSentByManual();
      switchChallanTab('list');
      renderAll();
      showToast(`Challan ${id} created.`, 'emerald');
    });

    document.getElementById('addVendorForm').addEventListener('submit', e => {
      e.preventDefault();
      const name = document.getElementById('newVendorName').value.trim();
      const role = document.getElementById('newVendorSpec').value.trim() || 'Custom Printing Vendor';
      if (!name) return;
      if (state.vendors.some(vendor => vendor.name.toLowerCase() === name.toLowerCase())) {
        showToast(`Vendor "${name}" already exists.`, 'amber');
        return;
      }
      state.vendors.push({ name, role, prefix: getVendorPrefix(name), challanSequence: 0 });
      logActivity(`Vendor added: ${name}`);
      saveState();
      e.target.reset();
      renderAll();
      showToast(`Vendor "${name}" added.`, 'emerald');
    });

    function vendorLedger(challan) {
      if (!Array.isArray(challan.vendorLedger)) challan.vendorLedger = [];
      return challan.vendorLedger;
    }

    function activeVendorTrip(challan, vendorName) {
      const vendorKey = vendorName.trim().toLowerCase();
      return vendorLedger(challan).slice().reverse().find(trip =>
        String(trip.vendor || '').trim().toLowerCase() === vendorKey
        && !trip.receivedDate
        && !trip.forwardedDate
      );
    }

    function addVendorTrip(challan, vendorName, sentDate) {
      const trip = {
        vendor: vendorName,
        sentQty: Number(challan.paperQty || 0),
        sentDate,
        receivedQty: 0,
        receivedDate: '',
        forwardedQty: 0,
        forwardedDate: ''
      };
      vendorLedger(challan).push(trip);
      return trip;
    }

    document.getElementById('forwardVendorForm').addEventListener('submit', e => {
      e.preventDefault();
      if (!['Admin', 'Manager'].includes(window.printzoneUser?.role)) {
        showToast('Vendor transfers are managed by an administrator or manager.', 'amber');
        return;
      }
      const id = document.getElementById('forwardChallanId').value;
      const sel = document.getElementById('forwardVendorSelect').value;
      const nextVendor = sel === '__manual__' ? document.getElementById('forwardManualInput').value.trim() : sel;
      const ch = state.challans.find(c => c.id === id);
      if (!ch || !nextVendor) return;
      if (ch.receivedFromVendor) {
        showToast('This challan is already received at PrintZone.', 'amber');
        return;
      }
      if (nextVendor.toLowerCase() === ch.vendor.toLowerCase()) {
        showToast('Select a different vendor for transfer.', 'amber');
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      const currentVendor = ch.vendor;
      const sku = paperSku(ch.paperType || '', ch.paperSize || '', ch.gsm || 0);
      const trackedPaper = state.stockFlow.some(flow =>
        flow.challanNo === ch.id && flow.sku && ['SENT', 'TRANSFER'].includes(flow.type)
      );
      if ((ch.quality || ch.paperSentBy || state.paperMeta[sku]) && !trackedPaper) {
        showToast('Send the challan paper before transferring it to another vendor.', 'amber');
        return;
      }
      let currentTrip = activeVendorTrip(ch, ch.vendor);
      if (!currentTrip && (
        ch.sentDate
        || /^(paper sent to|sent to)/i.test(ch.status || '')
      )) {
        currentTrip = addVendorTrip(ch, ch.vendor, ch.sentDate || today);
      }
      if (!currentTrip) currentTrip = addVendorTrip(ch, currentVendor, today);
      const transferQty = Math.max(
        0,
        Number(currentTrip.sentQty || 0)
          + Number(currentTrip.incomingQty || 0)
          - Number(currentTrip.receivedQty || 0)
          - Number(currentTrip.forwardedQty || 0)
      );
      if (!transferQty) {
        showToast('There is no paper quantity available to transfer to another vendor.', 'amber');
        return;
      }
      const existingVendor = state.vendors.find(item =>
        item.name.toLowerCase() === nextVendor.toLowerCase()
      );
      if (!existingVendor) {
        state.vendors.push({
          name: nextVendor,
          role: 'Custom Printing Vendor',
          prefix: getVendorPrefix(nextVendor),
          challanSequence: 0
        });
      }
      const targetVendor = existingVendor ? existingVendor.name : nextVendor;
      if (trackedPaper && !movePaper({
          sku,
          from: locationForVendor(currentVendor),
          to: locationForVendor(targetVendor),
          quantity: transferQty,
          challanNo: ch.id,
          note: `Transferred from ${currentVendor} to ${targetVendor}`,
          type: 'TRANSFER'
        })) {
        showToast(`Insufficient paper stock at ${currentVendor} to complete this transfer.`, 'amber');
        return;
      }
      currentTrip.forwardedQty = Number(currentTrip.forwardedQty || 0) + transferQty;
      currentTrip.forwardedDate = today;
      currentTrip.forwardedTo = targetVendor;
      vendorLedger(ch).push({
        vendor: targetVendor,
        sourceVendor: currentVendor,
        incomingQty: transferQty,
        incomingDate: today,
        sentQty: 0,
        sentDate: '',
        receivedQty: 0,
        receivedDate: '',
        forwardedQty: 0,
        forwardedDate: ''
      });
      ch.vendor = targetVendor;
      ch.sentDate = today;
      ch.status = `Sent to ${targetVendor}`;
      ch.history = ch.history || [];
      ch.history.push(`Sent to ${targetVendor}`);
      state.orders.filter(order => order.challanNo === ch.id).forEach(order => {
        order.vendor = targetVendor;
      });
      logActivity(`Challan ${ch.id} sent to ${targetVendor}`);
      saveState();
      closeForwardModal();
      renderAll();
      showToast(`${ch.id} sent to ${targetVendor}.`, 'indigo');
    });

    document.getElementById('editChallanForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const challan = state.challans.find(item => item.id === document.getElementById('editChallanId').value);
      if (!challan) return;
      const nextVendor = document.getElementById('editChallanVendor').value.trim();
      const wasSent = challan.receivedFromVendor || /^(paper sent|sent to)/i.test(challan.status || '');
      const existingVendor = state.vendors.find(item => item.name.toLowerCase() === nextVendor.toLowerCase());
      if (!existingVendor) {
        state.vendors.push({
          name: nextVendor,
          role: 'Custom Printing Vendor',
          prefix: getVendorPrefix(nextVendor),
          challanSequence: 0
        });
      }
      challan.vendor = existingVendor ? existingVendor.name : nextVendor;
      challan.jobType = document.getElementById('editChallanJobType').value;
      challan.paperType = document.getElementById('editChallanPaperType').value.trim();
      challan.paperSize = document.getElementById('editChallanPaperSize').value.trim();
      challan.paperQty = Number(document.getElementById('editChallanQty').value);
      state.orders.filter(order => order.challanNo === challan.id).forEach(order => {
        order.vendor = challan.vendor;
      });
      challan.status = challan.receivedFromVendor
        ? 'Received at PrintZone'
        : wasSent
          ? `Sent to ${challan.vendor}`
          : `Created (${challan.vendor})`;
      challan.history = challan.history || [];
      challan.history.push(`Updated for ${challan.vendor}`);
      logActivity(`Challan ${challan.id} updated`);
      saveState();
      closeEditChallan();
      renderAll();
      showToast(`Challan ${challan.id} updated.`, 'emerald');
    });

    document.getElementById('editPendingJobForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const order = state.orders.find(item => item.id === document.getElementById('editPendingJobId').value);
      if (!order || order.stage !== 'pending') return;
      if (order.challanNo) {
        const challan = state.challans.find(item => item.id === order.challanNo);
        if (challan?.receivedFromVendor) {
          showToast('Received challan jobs cannot be edited here.', 'amber');
          return;
        }
      }
      const party = state.parties.find(item => item.id === document.getElementById('editPendingJobParty').value);
      if (!party) return;
      order.partyId = party.id;
      order.partyName = party.name;
      order.name = document.getElementById('editPendingJobName').value.trim();
      order.qty = Number(document.getElementById('editPendingJobQty').value);
      order.size = document.getElementById('editPendingJobSize').value.trim();
      order.printingType = document.getElementById('editPendingJobPrinting').value.trim();
      order.jobType = document.getElementById('editPendingJobType').value;
      logActivity(`Pending job ${order.id} edited`);
      saveState();
      closeEditPendingJob();
      renderAll();
      showToast(`Pending job ${order.id} updated.`, 'emerald');
    });

    document.getElementById('addStockForm').addEventListener('submit', e => {
      e.preventDefault();
      const pType = document.getElementById('addPaperType').value.trim();
      const pSize = document.getElementById('addPaperSize').value.trim();
      const gsm = Number(document.getElementById('addPaperGsm').value);
      const qty = parseInt(document.getElementById('addPaperQty').value, 10) || 0;
      const source = document.getElementById('addPaperSource').value;
      if (!pType || !pSize || gsm <= 0 || qty <= 0 || !source) return;
      const sku = paperSku(pType, pSize, gsm);
      state.paperMeta[sku] = { paperType: pType, paperSize: pSize, gsm };
      state.paperLocations[sku] = state.paperLocations[sku] || {};
      const nextBal = paperLocationBalance(sku, 'Printzone') + qty;
      setPaperLocationBalance(sku, 'Printzone', nextBal);
      state.paperAdded[sku] = Number(state.paperAdded[sku] || 0) + qty;
      state.paperSent[sku] = Number(state.paperSent[sku] || 0);
      state.stockFlow.unshift({
        type: 'RECEIVED', paperType: pType, paperSize: pSize, gsm, qty,
        note: `Added from ${source}`, from: source, to: 'Printzone',
        challanNo: '-', balanceAfter: nextBal,
        date: new Date().toISOString().slice(0, 10)
      });
      logActivity(`Added +${qty.toLocaleString()} sheets (${sku})`);
      saveState();
      e.target.reset();
      renderAll();
      showToast(`Added +${qty.toLocaleString()} sheets.`, 'emerald');
    });

    document.getElementById('sendPaperForm').addEventListener('submit', e => {
      e.preventDefault();
      const sku = document.getElementById('sendPaperType').value;
      const vendor = document.getElementById('sendVendor').value.trim();
      const sentBy = document.getElementById('sendPaperBy').value;
      const qty = parseInt(document.getElementById('sendPaperQty').value, 10) || 0;
      const challanNo = document.getElementById('sendChallan').value;
      const challan = state.challans.find(item => item.id === challanNo);
      if (!sku || !vendor || !sentBy || qty <= 0 || !challanNo || !challan) return;
      if (state.stockFlow.some(flow =>
        flow.challanNo === challanNo && ['SENT', 'TRANSFER'].includes(flow.type)
      )) {
        showToast(`Paper for ${challanNo} has already been sent.`, 'amber');
        return;
      }
      const meta = state.paperMeta[sku] || {};
      if (
        vendor !== challan.vendor
        || sku !== paperSku(challan.paperType || '', challan.paperSize || '', challan.gsm || 0)
        || qty !== Number(challan.paperQty || 0)
      ) {
        showToast('Paper type, size, GSM, quantity, vendor, and challan must match.', 'amber');
        return;
      }
      if (
        paperSku(meta.paperType || '', document.getElementById('sendPaperSize').value,
          document.getElementById('sendPaperGsm').value) !== sku
      ) {
        showToast('Select the paper type, size, and GSM for one stock item.', 'amber');
        return;
      }
      if (!movePaper({
        sku, from: 'Printzone', to: locationForVendor(vendor), quantity: qty,
        challanNo, note: `Sent to ${vendor} by ${sentBy}`, type: 'SENT'
      })) {
        const available = paperLocationBalance(sku, 'Printzone');
        showToast(`Required stock: ${qty.toLocaleString()} sheets; available at Printzone: ${available.toLocaleString()}.`, 'amber');
        return;
      }
      challan.paperSentBy = sentBy;
      challan.paperSentDate = challan.paperSentDate || new Date().toISOString().slice(0, 10);
      challan.sentDate = challan.sentDate || new Date().toISOString().slice(0, 10);
      challan.status = `Paper Sent to ${vendor}`;
      challan.history = challan.history || [];
      challan.history.push(`Paper sent to ${vendor} (${qty.toLocaleString()})`);
      if (!activeVendorTrip(challan, vendor)) {
        addVendorTrip(challan, vendor, new Date().toISOString().slice(0, 10));
      }
      logActivity(`Sent ${qty.toLocaleString()} sheets of ${meta.paperType} to ${vendor} (${challanNo})`);
      saveState();
      e.target.reset();
      renderAll();
      showToast(`Sent ${qty.toLocaleString()} sheets to ${vendor}.`, 'emerald');
    });

    document.getElementById('receivePaperForm').addEventListener('submit', e => {
      e.preventDefault();
      const sku = document.getElementById('receivePaperType').value;
      const vendor = document.getElementById('receivePaperVendor').value;
      const challanNo = document.getElementById('receivePaperChallan').value;
      const qty = Number(document.getElementById('receivePaperQty').value);
      const challan = state.challans.find(item => item.id === challanNo);
      if (!sku || !vendor || !challan || qty <= 0) return;
      if (!movePaper({
        sku, from: locationForVendor(vendor), to: 'Printzone', quantity: qty,
        challanNo, note: `Received from ${vendor}`, type: 'RECEIVED'
      })) {
        const available = paperLocationBalance(sku, locationForVendor(vendor));
        showToast(`Required receipt: ${qty.toLocaleString()} sheets; available at ${vendor}: ${available.toLocaleString()}.`, 'amber');
        return;
      }
      challan.history = challan.history || [];
      challan.history.push(`Paper received from ${vendor} (${qty.toLocaleString()})`);
      saveState();
      e.target.reset();
      renderAll();
      showToast(`Received ${qty.toLocaleString()} sheets from ${vendor}.`, 'emerald');
    });

    // Tally Import & Export
    document.getElementById('tallyFileInput').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        const text = ev.target.result;
        try {
          if (file.name.endsWith('.json')) {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) state.tallyRows = parsed.concat(state.tallyRows);
          } else {
            const lines = text.split(/\r?\n/).filter(Boolean).slice(1);
            lines.forEach(line => {
              const cols = line.split(',');
              if (cols.length >= 3) {
                state.tallyRows.unshift({ date: cols[0], party: cols[1], voucher: cols[2], amount: parseFloat(cols[3] || 0) });
              }
            });
          }
          saveState();
          renderAll();
          showToast(`Imported Tally file "${file.name}".`, 'emerald');
        } catch (err) {
          showToast('Could not parse Tally file. Use CSV (Date,Party,Voucher,Amount) or JSON.', 'rose');
        }
      };
      reader.readAsText(file);
    });

    window.exportTallyCsv = () => {
      const rows = ['Date,Party,OrderID,ItemName,Qty,Rate,Total'];
      state.orders.filter(o => o.stage === 'dispatch').forEach(o => {
        rows.push(`${o.dispatch.date || ''},${o.partyName},${o.id},${o.name},${o.qty},${o.dispatch.rate},${(o.qty * o.dispatch.rate).toFixed(2)}`);
      });
      const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'printzone_tally_dispatch.csv';
      a.click();
      showToast('Exported Dispatched orders for Tally.', 'indigo');
    };

    // Global Row Actions
    window.updatePendingStatus = (orderId, val) => {
      const o = state.orders.find(x => x.id === orderId);
      if (!o) return;
      const nextStatus = val === 'In Process' ? 'In Progress' : val;
      if (!['Pending', 'In Progress', 'Done'].includes(nextStatus)) return;
      if (o.challanNo && nextStatus !== 'Done') {
        showToast('Remove the job from its active challan before changing its design status.', 'amber');
        renderAll();
        return;
      }
      o.printingStatus = nextStatus;
      saveState();
      renderAll();
    };

    window.punchPendingOrder = (orderId) => {
      const o = state.orders.find(x => x.id === orderId);
      if (!o) return;
      const ch = document.getElementById(`pendCh-${orderId}`).value;
      const ven = document.getElementById(`pendVen-${orderId}`).value;
      if (!ch || !ven) {
        showToast('Select both Challan No. and Vendor.', 'amber');
        return;
      }
      if (o.printingStatus !== 'Done' || o.challanNo) {
        showToast('Only completed, unassigned jobs can be added to a challan.', 'amber');
        return;
      }
      const challan = state.challans.find(item => item.id === ch);
      if (!challan || challan.vendor.toLowerCase() !== ven.toLowerCase()) {
        showToast('Choose a challan assigned to the selected vendor.', 'amber');
        return;
      }
      o.printingStatus = 'Done';
      o.challanNo = ch;
      o.vendor = challan.vendor;
      if (!challan.jobType) challan.jobType = o.jobType;
      if (challan.receivedFromVendor) {
        o.stage = 'production';
        o.prod.receivedFromVendor = true;
      }
      logActivity(`${o.id} (${o.name}) punched to ${ch} (${ven})`);
      saveState();
      renderAll();
      showToast(`${o.name} punched to ${ch}!`, 'emerald');
    };

    window.challanAction = (challanId, act) => {
      const ch = state.challans.find(c => c.id === challanId);
      if (!ch) return;
      if (act === 'send-challan') {
        if (ch.sentDate) {
          showToast(`${ch.id} has already been sent to ${ch.vendor}.`, 'amber');
          return;
        }
        ch.sentDate = new Date().toISOString().slice(0, 10);
        ch.status = `Sent to ${ch.vendor}`;
        ch.history = ch.history || [];
        ch.history.push(`Challan sent to ${ch.vendor} on ${ch.sentDate}`);
      } else if (act === 'sent') {
        if (window.printzoneUser?.role === 'User') {
          showToast('Paper transfers are managed in Paper Stock by an administrator or accountant.', 'amber');
          return;
        }
        const trip = activeVendorTrip(ch, ch.vendor);
        if (trip && Number(trip.incomingQty || 0) > 0) {
          showToast(`${ch.id} was received by ${ch.vendor} from ${trip.sourceVendor || 'another vendor'}.`, 'amber');
          return;
        }
        const legacySent = !ch.vendorLedger?.length && /^paper sent to/i.test(ch.status || '');
        if (ch.paperSentDate || (trip && Number(trip.sentQty || 0) > 0) || legacySent) {
          showToast(`${ch.id} is already marked as sent to ${ch.vendor}.`, 'amber');
          return;
        }
        const sku = paperSku(ch.paperType || '', ch.paperSize || '', ch.gsm || 0);
        const quantity = Number(ch.paperQty || 0);
        const available = paperLocationBalance(sku, 'Printzone');
        if (quantity > available) {
          const requirement = document.getElementById('challanStockRequirement');
          requirement.innerHTML = `
            <p class="font-bold text-amber-200">Paper stock required for ${escapeHtml(ch.id)}</p>
            <ul class="mt-2 list-disc pl-5 text-xs text-slate-200">
              <li>${escapeHtml(ch.paperType)} · ${escapeHtml(ch.paperSize)} · ${Number(ch.gsm || 0)} GSM:
                ${quantity.toLocaleString()} sheets required; ${available.toLocaleString()} available;
                ${(quantity - available).toLocaleString()} more needed.</li>
            </ul>
            <button type="button" class="mt-2 text-xs font-bold text-amber-200 underline" onclick="navTo('paper-stock')">Open Paper Stock</button>`;
          requirement.classList.remove('hidden');
          showToast(`Insufficient paper stock for ${ch.id}. Required stock is listed above.`, 'amber');
          return;
        }
        document.getElementById('challanStockRequirement').classList.add('hidden');
        state.paperMeta[sku] = state.paperMeta[sku] || {
          paperType: ch.paperType || '', paperSize: ch.paperSize || '', gsm: Number(ch.gsm || 0)
        };
        const sentDate = new Date().toISOString().slice(0, 10);
        if (!movePaper({
          sku,
          from: 'Printzone',
          to: locationForVendor(ch.vendor),
          quantity,
          challanNo: ch.id,
          note: `Sent to ${ch.vendor} by ${ch.paperSentBy || 'Printzone'}`,
          type: 'SENT'
        })) {
          showToast(`Unable to transfer the required paper for ${ch.id}.`, 'rose');
          return;
        }
        addVendorTrip(ch, ch.vendor, sentDate);
        ch.sentDate = ch.sentDate || sentDate;
        ch.paperSentDate = sentDate;
        ch.status = `Paper Sent to ${ch.vendor}`;
        ch.history = ch.history || [];
        ch.history.push(`Paper Sent to ${ch.vendor} (${Number(ch.paperQty || 0).toLocaleString()})`);
        showToast(`${ch.id} Paper Sent.`, 'emerald');
      } else if (act === 'forward') {
        if (ch.receivedFromVendor) {
          showToast('This challan is already received at PrintZone.', 'amber');
          return;
        }
        document.getElementById('forwardChallanId').value = ch.id;
        const forwardVendorSelect = document.getElementById('forwardVendorSelect');
        document.getElementById('forwardManualInput').value = '';
        const nextVendor = state.vendors.find(vendor =>
          vendor.name.toLowerCase() !== ch.vendor.toLowerCase()
        );
        forwardVendorSelect.value = nextVendor ? nextVendor.name : '__manual__';
        toggleForwardManual();
        document.getElementById('forwardModal').classList.remove('hidden');
        return;
      } else if (act === 'received') {
        if (ch.receivedFromVendor) {
          showToast(`${ch.id} has already been received at PrintZone.`, 'amber');
          return;
        }
        const receivedDate = new Date().toISOString().slice(0, 10);
        let trip = activeVendorTrip(ch, ch.vendor);
        if (!trip) {
          trip = addVendorTrip(ch, ch.vendor, ch.sentDate || receivedDate);
        }
        trip.receivedQty = Math.max(
          0,
          Number(trip.sentQty || 0)
            + Number(trip.incomingQty || 0)
            - Number(trip.forwardedQty || 0)
        );
        trip.receivedDate = receivedDate;
        ch.receivedFromVendor = true;
        ch.receivedDate = receivedDate;
        ch.status = 'Received at PrintZone';
        ch.history = ch.history || [];
        ch.history.push(`Received at PrintZone from ${ch.vendor} (${trip.receivedQty.toLocaleString()}, ${ch.receivedDate})`);
        let moved = 0;
        state.orders.forEach(o => {
          if (o.challanNo === ch.id && (o.stage === 'pending' || o.stage === 'production')) {
            o.stage = 'production';
            o.prod.receivedFromVendor = true;
            moved++;
          }
        });
        showToast(`${ch.id} received! ${moved} order(s) auto-moved to Production.`, 'emerald');
      }
      logActivity(`Challan ${ch.id}: ${ch.status}`);
      saveState();
      renderAll();
    };

    function currentProductionStage(order) {
      if (!order.prod.receivedFromVendor) return 'receivedFromVendor';
      if (!order.prod.lamination && !order.prod.laminationSkipped) return 'lamination';
      if (!order.prod.cutting) return 'cutting';
      if (!order.prod.pasting) return 'pasting';
      if (!order.prod.ready) return 'ready';
      return 'complete';
    }

    window.advanceProdStage = (orderId, action) => {
      const o = state.orders.find(x => x.id === orderId);
      if (!o) return;
      const stage = currentProductionStage(o);
      const laminationAction = action === 'complete-lamination' || action === 'skip-lamination';
      if (stage === 'complete' || (laminationAction ? stage !== 'lamination' : action !== stage)) {
        showToast('Complete the current production stage before continuing.', 'amber');
        return;
      }
      if (stage === 'lamination') {
        if (action === 'skip-lamination') o.prod.laminationSkipped = true;
        else o.prod.lamination = true;
      } else {
        o.prod[action] = true;
      }
      if (action === 'ready') {
        o.stage = 'dispatch';
        o.dispatch.date = o.dispatch.date || new Date().toISOString().slice(0, 10);
        o.dispatch.status = 'Ready';
        logActivity(`${o.id} (${o.name}) Ready — moved to Dispatch`);
        showToast(`${o.name} moved to Dispatch!`, 'emerald');
      }
      saveState();
      renderAll();
    };

    window.updateDispatchField = (orderId, field, value) => {
      const o = state.orders.find(x => x.id === orderId);
      if (!o) return;
      o.dispatch[field] = field === 'rate' ? (parseFloat(value) || 0) : value;
      saveState();
      renderAll();
    };

    function attachmentMarkup(data, label) {
      if (!data) return '';
      const isPdf = data.startsWith('data:application/pdf;');
      const preview = isPdf
        ? '<span class="file-preview pdf-preview">PDF</span>'
        : `<img src="${data}" alt="${label} preview" class="file-preview" />`;
      return `<a class="attachment-link" href="${data}" target="_blank" rel="noopener" download="${label.toLowerCase()}-receipt.${isPdf ? 'pdf' : 'jpg'}" aria-label="View or download ${label}">${preview}<span>${isPdf ? 'View / download PDF' : 'View / download image'}</span></a>`;
    }

    window.uploadOrderImage = (orderId, field, input) => {
      const file = input.files[0];
      if (!file) return;
      if (!['image/jpeg', 'image/png', 'application/pdf'].includes(file.type)) {
        input.value = '';
        showToast('Upload a JPG, PNG, or PDF file.', 'rose');
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        input.value = '';
        showToast('Files must be 2 MB or smaller.', 'rose');
        return;
      }
      const reader = new FileReader();
      reader.onload = ev => {
        const o = state.orders.find(x => x.id === orderId);
        if (o) {
          o.dispatch[field] = ev.target.result;
          saveState();
          renderAll();
          showToast(`${field === 'biltyImg' ? 'Builty' : 'Product'} image uploaded.`, 'emerald');
        }
      };
      reader.readAsDataURL(file);
    };

    window.openChallanModal = (challanId) => {
      const ch = state.challans.find(c => c.id === challanId);
      if (!ch) return;
      const linked = state.orders.filter(o => o.challanNo === ch.id);
      const jobTypes = [...new Set(linked.map(order => order.jobType).filter(Boolean))];
      const jobQuantity = linked.reduce((sum, order) => sum + Number(order.qty || 0), 0);
      document.getElementById('modalChallanTitle').textContent = `${ch.id} — ${ch.vendor}`;
      document.getElementById('modalChallanBody').innerHTML = `
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 bg-white/5 p-4 rounded-xl border border-white/10">
          <div><div class="text-[11px] text-slate-400">Vendor</div><div class="font-bold text-white">${escapeHtml(ch.vendor)}</div></div>
          <div><div class="text-[11px] text-slate-400">Job Type</div><div class="font-bold text-white">${escapeHtml(jobTypes.join(', ') || ch.jobType || 'Unassigned')}</div></div>
          <div><div class="text-[11px] text-slate-400">Job Qty</div><div class="font-bold text-white">${jobQuantity.toLocaleString()}</div></div>
          <div><div class="text-[11px] text-slate-400">Challan Date</div><div class="font-bold text-white">${escapeHtml(ch.challanDate || ch.sentDate || '-')}</div></div>
          <div><div class="text-[11px] text-slate-400">Received Date</div><div class="font-bold text-emerald-400">${escapeHtml(ch.receivedDate || 'Pending')}</div></div>
          <div><div class="text-[11px] text-slate-400">Paper</div><div class="font-bold text-white">${escapeHtml(ch.paperType)} (${escapeHtml(ch.paperSize)})</div></div>
          <div><div class="text-[11px] text-slate-400">GSM / Quality</div><div class="font-bold text-white">${Number(ch.gsm || 0) || '-'} GSM · ${escapeHtml(ch.quality || '-')}</div></div>
          <div><div class="text-[11px] text-slate-400">Paper Sent By</div><div class="font-bold text-white">${escapeHtml(ch.paperSentBy || '-')}</div></div>
          <div><div class="text-[11px] text-slate-400">Paper Qty</div><div class="font-bold text-white">${Number(ch.paperQty || 0).toLocaleString()}</div></div>
          <div><div class="text-[11px] text-slate-400">Received?</div><div class="font-bold">${ch.receivedFromVendor ? 'YES' : 'NO'}</div></div>
          <div><div class="text-[11px] text-slate-400">Status</div><div class="font-bold text-cyan-300">${escapeHtml(ch.status)}</div></div>
        </div>
        <div>
          <h4 class="font-bold text-white mb-2">Linked Products (${linked.length})</h4>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs">
              <thead class="text-slate-400"><tr><th class="py-2 pr-3">Job ID</th><th class="py-2 pr-3">Party / Item</th><th class="py-2 pr-3">Size</th><th class="py-2 text-right">Quantity</th></tr></thead>
              <tbody>${linked.map(order => `<tr class="border-t border-white/10"><td class="py-2 pr-3 font-mono text-pink-400">${escapeHtml(order.id)}</td><td class="py-2 pr-3 font-semibold text-white">${escapeHtml(order.partyName)} · ${escapeHtml(order.name)}</td><td class="py-2 pr-3">${escapeHtml(order.size)}</td><td class="py-2 text-right">${Number(order.qty || 0).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="4" class="py-3 text-center text-slate-400">No jobs assigned.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
        <div class="flex justify-end"><button type="button" onclick="printChallan('${escapeHtml(ch.id)}')" class="px-3 py-2 rounded-lg bg-pink-600 text-white text-xs font-bold">Print / Save PDF</button></div>
      `;
      document.getElementById('challanModal').classList.remove('hidden');
    };

    window.printChallan = challanId => {
      const challan = state.challans.find(item => item.id === challanId);
      if (!challan) return;
      const linkedOrders = state.orders.filter(order => order.challanNo === challan.id);
      const printWindow = window.open('', '_blank');
      if (!printWindow) {
        showToast('Allow pop-ups to print or save this challan as a PDF.', 'amber');
        return;
      }

      const doc = printWindow.document;
      doc.title = `Challan ${challan.id}`;
      const style = doc.createElement('style');
      style.textContent = 'body{font:14px Arial,sans-serif;color:#172033;margin:32px}h1{font-size:22px;margin:0 0 6px}h2{font-size:14px;margin:24px 0 8px}p{margin:4px 0;color:#475467}.details{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:22px 0}.details div{border:1px solid #d0d5dd;border-radius:6px;padding:10px}table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #d0d5dd;padding:9px;text-align:left}th{background:#f2f4f7}.total{text-align:right;font-weight:bold;margin-top:12px}@media print{body{margin:18mm}}';
      doc.head.appendChild(style);
      const heading = doc.createElement('h1');
      heading.textContent = 'PRINT ZONE — VENDOR CHALLAN';
      doc.body.appendChild(heading);
      const number = doc.createElement('p');
      number.textContent = challan.id;
      doc.body.appendChild(number);

      const details = doc.createElement('div');
      details.className = 'details';
      [
        ['Vendor', challan.vendor],
        ['Challan date', challan.challanDate || challan.sentDate || '-'],
        ['Job type', challan.jobType || '-'],
        ['Status', challan.status || 'Created'],
        ['Paper', `${challan.paperType || '-'} · ${challan.paperSize || '-'} · ${Number(challan.gsm || 0) || '-'} GSM`],
        ['Quality', challan.quality || '-'],
        ['Paper sent by', challan.paperSentBy || '-'],
        ['Paper sent', Number(challan.paperQty || 0).toLocaleString()]
      ].forEach(([label, value]) => {
        const field = doc.createElement('div');
        const caption = doc.createElement('strong');
        caption.textContent = `${label}: `;
        field.append(caption, doc.createTextNode(String(value)));
        details.appendChild(field);
      });
      doc.body.appendChild(details);

      const subheading = doc.createElement('h2');
      subheading.textContent = 'Assigned items';
      doc.body.appendChild(subheading);
      const table = doc.createElement('table');
      const header = doc.createElement('tr');
      ['Job ID', 'Party', 'Brand / Item', 'Size', 'Quantity', 'Job type'].forEach(label => {
        const cell = doc.createElement('th');
        cell.textContent = label;
        header.appendChild(cell);
      });
      table.appendChild(header);
      linkedOrders.forEach(order => {
        const row = doc.createElement('tr');
        [
          order.id, order.partyName, order.name, order.size,
          Number(order.qty || 0).toLocaleString(), order.jobType
        ].forEach(value => {
          const cell = doc.createElement('td');
          cell.textContent = String(value || '-');
          row.appendChild(cell);
        });
        table.appendChild(row);
      });
      doc.body.appendChild(table);
      const total = doc.createElement('p');
      total.className = 'total';
      total.textContent = `Total job quantity: ${linkedOrders.reduce((sum, order) => sum + Number(order.qty || 0), 0).toLocaleString()}`;
      doc.body.appendChild(total);
      printWindow.focus();
      printWindow.print();
    };

    window.openEditChallan = (challanId) => {
      const challan = state.challans.find(item => item.id === challanId);
      if (!challan) return;
      document.getElementById('editChallanId').value = challan.id;
      document.getElementById('editChallanVendor').value = challan.vendor || '';
      document.getElementById('editChallanJobType').value = challan.jobType || '';
      document.getElementById('editChallanPaperType').value = challan.paperType || '';
      document.getElementById('editChallanPaperSize').value = challan.paperSize || '';
      document.getElementById('editChallanQty').value = challan.paperQty || 1;
      document.getElementById('editChallanModal').classList.remove('hidden');
    };
    window.closeEditChallan = () => document.getElementById('editChallanModal').classList.add('hidden');
    window.openEditPendingJob = (orderId) => {
      const order = state.orders.find(item => item.id === orderId);
      if (!order || order.stage !== 'pending') return;
      if (order.challanNo) {
        const challan = state.challans.find(item => item.id === order.challanNo);
        if (challan?.receivedFromVendor) {
          showToast('Received challan jobs cannot be edited here.', 'amber');
          return;
        }
      }
      document.getElementById('editPendingJobId').value = order.id;
      document.getElementById('editPendingJobParty').innerHTML = state.parties.map(party =>
        `<option value="${escapeHtml(party.id)}">${escapeHtml(party.name)}</option>`
      ).join('');
      document.getElementById('editPendingJobParty').value = order.partyId;
      document.getElementById('editPendingJobName').value = order.name || '';
      document.getElementById('editPendingJobQty').value = order.qty || 1;
      document.getElementById('editPendingJobSize').value = order.size || '';
      document.getElementById('editPendingJobPrinting').value = order.printingType || '';
      document.getElementById('editPendingJobType').value = order.jobType || 'Box';
      document.getElementById('editPendingJobModal').classList.remove('hidden');
    };
    window.closeEditPendingJob = () => document.getElementById('editPendingJobModal').classList.add('hidden');
    window.deleteChallan = (challanId) => {
      const challan = state.challans.find(item => item.id === challanId);
      if (!challan) return;
      const linkedOrders = state.orders.filter(order => order.challanNo === challanId);
      if (linkedOrders.some(order => order.stage === 'dispatch')) {
        showToast('This challan has completed production orders and cannot be deleted.', 'amber');
        return;
      }
      if (!window.confirm(`Delete challan ${challan.id}? Assigned jobs will return to Pending.`)) return;

      const reversedEntries = state.stockFlow.filter(flow =>
        flow.challanNo === challanId && ['SENT', 'TRANSFER'].includes(flow.type)
      );
      reversedEntries.forEach(flow => {
        const quantity = Math.abs(Number(flow.qty) || 0);
        const sku = flow.sku || flow.paperType;
        if (flow.sku && flow.from && flow.to) {
          setPaperLocationBalance(
            sku, flow.from, paperLocationBalance(sku, flow.from) + quantity
          );
          setPaperLocationBalance(
            sku, flow.to, Math.max(0, paperLocationBalance(sku, flow.to) - quantity)
          );
        } else {
          state.paperStock[sku] = Number(state.paperStock[sku] || 0) + quantity;
        }
        if (!flow.from || flow.from === 'Printzone') {
          state.paperSent[sku] = Math.max(0, Number(state.paperSent[sku] || 0) - quantity);
        }
      });
      state.stockFlow = state.stockFlow.filter(flow =>
        !(flow.challanNo === challanId && ['SENT', 'TRANSFER'].includes(flow.type))
      );
      linkedOrders.forEach(order => {
        order.challanNo = '';
        order.vendor = '';
        order.printingStatus = 'In Process';
        order.stage = 'pending';
        order.prod = {
          receivedFromVendor: false,
          lamination: false,
          laminationSkipped: false,
          cutting: false,
          pasting: false,
          ready: false
        };
      });
      state.challans = state.challans.filter(item => item.id !== challanId);
      logActivity(`Challan ${challanId} deleted`);
      saveState();
      renderAll();
      showToast(`Challan ${challanId} deleted and assigned jobs returned to Pending.`, 'emerald');
    };
    window.deleteOrder = orderId => {
      const order = state.orders.find(item => item.id === orderId);
      if (!order) return;
      if (window.printzoneUser?.role === 'User' && order.stage === 'dispatch') {
        showToast('This account cannot delete dispatched orders.', 'amber');
        return;
      }
      const warning = order.stage === 'dispatch'
        ? ' This also removes it from dispatch and customer tracking.'
        : '';
      if (!window.confirm(`Permanently delete ${order.id} — ${order.name}?${warning}`)) return;
      state.orders = state.orders.filter(item => item.id !== orderId);
      logActivity(`Order ${order.id} deleted`);
      saveState();
      renderAll();
      showToast(`Order ${order.id} deleted.`, 'emerald');
    };
    window.deleteParty = partyId => {
      const party = state.parties.find(item => item.id === partyId);
      if (!party) return;
      if (state.orders.some(order => order.partyId === partyId)) {
        showToast("Delete or reassign this party's orders before deleting the party.", 'amber');
        return;
      }
      if (!window.confirm(`Permanently delete party "${party.name}"?`)) return;
      state.parties = state.parties.filter(item => item.id !== partyId);
      logActivity(`Party deleted: ${party.name}`);
      saveState();
      renderAll();
      showToast(`Party "${party.name}" deleted.`, 'emerald');
    };
    window.closeChallanModal = () => document.getElementById('challanModal').classList.add('hidden');
    window.closeForwardModal = () => document.getElementById('forwardModal').classList.add('hidden');

    function renderAll() {
      populateVendorOptions();
      const approvalPending = state.orders.filter(order =>
        (order.approvalStatus || 'Approved') === 'Pending Approval'
      );
      const pendingOrders = state.orders.filter(o =>
        (o.approvalStatus || 'Approved') === 'Approved' &&
        o.stage === 'pending' && o.printingStatus !== 'Done' && !(o.challanNo && o.vendor)
      );
      const designInProgress = state.orders.filter(order =>
        order.approvalStatus === 'Approved'
        && order.stage === 'pending' && ['In Process', 'In Progress'].includes(order.printingStatus)
      );
      const designCompleted = state.orders.filter(order =>
        order.approvalStatus === 'Approved' && order.printingStatus === 'Done'
      );
      const awaitingChallan = state.orders.filter(order =>
        order.approvalStatus === 'Approved'
        && order.stage === 'pending' && order.printingStatus === 'Done' && !order.challanNo
      );
      const challanAssigned = state.orders.filter(order =>
        order.approvalStatus === 'Approved' && Boolean(order.challanNo)
      );
      const visibleJobs = {
        active: state.orders.filter(order =>
          order.approvalStatus === 'Approved'
          &&
          order.stage === 'pending'
          && ['Pending', undefined, ''].includes(order.printingStatus)
          && !order.challanNo
        ),
        'in-progress': designInProgress,
        completed: designCompleted,
        'awaiting-challan': awaitingChallan,
        assigned: challanAssigned
      }[pendingFilter] || pendingOrders;
      const prodOrders = state.orders.filter(o =>
        (o.approvalStatus || 'Approved') === 'Approved' && o.stage === 'production'
      );
      const dispatchOrders = state.orders.filter(o =>
        (o.approvalStatus || 'Approved') === 'Approved' && o.stage === 'dispatch'
      );
      const visibleDispatchOrders = dispatchFilter === 'all'
        ? dispatchOrders
        : dispatchOrders.filter(order => (order.dispatch?.status || 'Ready') === dispatchFilter);
      const totalStock = Object.values(state.paperStock).reduce((a, b) => a + b, 0);
      const readyToDispatch = dispatchOrders.filter(order =>
        (order.dispatch?.status || 'Ready') === 'Ready'
      ).length;
      const openChallans = state.challans.filter(challan => !challan.receivedFromVendor).length;
      const vendorOutstandingSheets = state.challans.reduce((sum, challan) => {
        const ledger = Array.isArray(challan.vendorLedger) ? challan.vendorLedger : [];
        if (ledger.length) {
          return sum + ledger.reduce((tripTotal, trip) =>
            tripTotal + Math.max(
              0,
              Number(trip.sentQty || 0)
                + Number(trip.incomingQty || 0)
                - Number(trip.receivedQty || 0)
                - Number(trip.forwardedQty || 0)
            ), 0
          );
        }
        const isSent = Boolean(challan.sentDate || /^(paper sent|sent to)/i.test(challan.status || ''));
        return sum + (isSent && !challan.receivedFromVendor ? Number(challan.paperQty || 0) : 0);
      }, 0);

      document.getElementById('badge-pending').textContent = pendingOrders.length;
      document.getElementById('badge-challan').textContent = state.challans.length;
      document.getElementById('badge-production').textContent = prodOrders.length;
      document.getElementById('badge-dispatch').textContent = dispatchOrders.length;
      document.getElementById('nextOrderIdPreview').textContent =
        `Next: ORD-${String(state.orders.length + 1).padStart(3, '0')}`;

      const kpis = [
        { label: 'Total Orders', val: state.orders.length, sub: 'Across all stages', icon: 'layers' },
        { label: 'Active Parties', val: state.parties.length, sub: 'Customer accounts', icon: 'users' },
        { label: 'Pending Design', val: pendingOrders.length, sub: 'Needs design work', icon: 'clock' },
        { label: 'Awaiting Challan', val: awaitingChallan.length, sub: 'Design completed', icon: 'file-plus-2' },
        { label: 'In Production', val: prodOrders.length, sub: 'On the production floor', icon: 'cpu' },
        { label: 'Ready to Dispatch', val: readyToDispatch, sub: 'Prepared for shipment', icon: 'package-check' },
        { label: 'Open Challans', val: openChallans, sub: 'Currently with vendors', icon: 'files' },
        { label: 'With Vendors', val: vendorOutstandingSheets.toLocaleString(), sub: 'Paper sheets outstanding', icon: 'truck' },
        { label: 'Paper Stock', val: totalStock.toLocaleString(), sub: 'Available sheets', icon: 'database' }
      ];
      document.getElementById('kpiGrid').innerHTML = kpis.map(k => `
        <div class="glass-card dashboard-kpi rounded-2xl p-5 card-lift hover:border-pink-500/40">
          <div class="flex items-start justify-between">
            <div>
              <p class="text-[11px] font-bold text-slate-400 uppercase tracking-widest">${k.label}</p>
              <p class="text-3xl font-extrabold text-white mt-1.5 font-display">${k.val}</p>
              <p class="text-[11px] font-semibold text-slate-400 mt-1">${k.sub}</p>
            </div>
            <div class="w-10 h-10 rounded-xl border border-white/10 bg-white/5 flex items-center justify-center text-slate-300">
              <i data-lucide="${k.icon}" class="w-4 h-4"></i>
            </div>
          </div>
        </div>
      `).join('');

      document.getElementById('activityFeed').innerHTML = state.activities.length ? state.activities.map(act => `
        <div class="py-2.5 flex items-center gap-2.5 text-slate-300"><span class="w-2 h-2 rounded-full bg-pink-500 shrink-0"></span><span>${escapeHtml(act)}</span></div>
      `).join('') : '<p class="py-6 text-center text-sm text-slate-500">Activity will appear here as you use the workspace.</p>';

      const pipelineCanvas = document.getElementById('pipelineChart');
      const hasOrders = state.orders.length > 0;
      pipelineCanvas.classList.toggle('hidden', !hasOrders);
      document.getElementById('pipelineEmpty').classList.toggle('hidden', hasOrders);
      if (!hasOrders && pipelineChartInst) {
        pipelineChartInst.destroy();
        pipelineChartInst = null;
      } else if (hasOrders) {
        const pipelineData = [pendingOrders.length + awaitingChallan.length, prodOrders.length, dispatchOrders.length];
        const legendColor = document.body.classList.contains('light-theme') ? '#334155' : '#cbd5e1';
        if (pipelineChartInst) {
          pipelineChartInst.data.datasets[0].data = pipelineData;
          pipelineChartInst.options.plugins.legend.labels.color = legendColor;
          pipelineChartInst.update('none');
        } else {
          pipelineChartInst = new Chart(pipelineCanvas.getContext('2d'), {
            type: 'doughnut',
            data: {
              labels: ['Pending', 'Production', 'Dispatch'],
              datasets: [{
                data: pipelineData,
                backgroundColor: ['#e5c46b', '#73a6c8', '#58a98d'],
                borderWidth: 0
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              animation: { duration: 240 },
              plugins: {
                legend: {
                  position: 'bottom',
                  labels: { color: legendColor, font: { weight: 'bold' } }
                }
              }
            }
          });
        }
      }

      const stockCanvas = document.getElementById('stockChart');
      const stockLabels = Object.keys(state.paperStock);
      const hasStock = stockLabels.length > 0;
      stockCanvas.classList.toggle('hidden', !hasStock);
      document.getElementById('stockEmpty').classList.toggle('hidden', hasStock);
      if (!hasStock && stockChartInst) {
        stockChartInst.destroy();
        stockChartInst = null;
      } else if (hasStock) {
        const stockValues = Object.values(state.paperStock);
        const axisColor = document.body.classList.contains('light-theme') ? '#475569' : '#aebacc';
        if (stockChartInst) {
          stockChartInst.data.labels = stockLabels;
          stockChartInst.data.datasets[0].data = stockValues;
          stockChartInst.options.scales.x.ticks.color = axisColor;
          stockChartInst.options.scales.y.ticks.color = axisColor;
          stockChartInst.update('none');
        } else {
          stockChartInst = new Chart(stockCanvas.getContext('2d'), {
            type: 'bar',
            data: {
              labels: stockLabels,
              datasets: [{ data: stockValues, backgroundColor: '#c9a84e', borderRadius: 8 }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              animation: { duration: 240 },
              plugins: { legend: { display: false } },
              scales: {
                x: { ticks: { color: axisColor } },
                y: { beginAtZero: true, ticks: { color: axisColor } }
              }
            }
          });
        }
      }

      // Party & Order
      document.getElementById('nextOrderIdPreview').textContent = `Next: ORD-${String(state.orders.length + 1).padStart(3, '0')}`;
      document.getElementById('orderParty').innerHTML = state.parties.map(p =>
        `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`
      ).join('');
      document.getElementById('partyList').innerHTML = state.parties.length ? state.parties.map(p => `
        <div class="p-3 rounded-xl bg-white/5 border border-white/10 text-xs flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="font-bold text-white">${escapeHtml(p.name)}</div>
            <div class="text-slate-400">${escapeHtml(p.mobile)} &bull; ${escapeHtml(p.gmail || 'No Gmail')}</div>
          </div>
          <button type="button" onclick="deleteParty('${escapeHtml(p.id)}')" ${state.orders.some(order => order.partyId === p.id) ? 'disabled title="Delete its orders first"' : ''} class="danger-action shrink-0">Delete</button>
        </div>
      `).join('') : '<p class="sm:col-span-2 lg:col-span-3 py-6 text-center text-sm text-slate-500">No parties yet. Add a party to get started.</p>';
      document.getElementById('allOrdersTable').innerHTML = state.orders.length ? state.orders.map(o => `
        <tr class="hover:bg-white/5">
          <td class="px-3 py-2.5 font-mono text-pink-400">${escapeHtml(o.id)}</td>
          <td class="px-3 py-2.5"><div class="font-bold text-white">${escapeHtml(o.name)}</div><div class="text-[11px] text-slate-400">${escapeHtml(o.partyName)}</div></td>
          <td class="px-3 py-2.5 text-xs text-slate-300">${escapeHtml(o.size)} &bull; ${escapeHtml(o.printingType)} &bull; ${escapeHtml(o.jobType)}</td>
          <td class="px-3 py-2.5 text-right text-white">${Number(o.qty || 0).toLocaleString()}</td>
          <td class="px-3 py-2.5"><span class="px-2 py-0.5 rounded-full text-xs font-bold bg-white/10 text-cyan-300">${escapeHtml(
            o.approvalStatus === 'Pending Approval'
              ? 'Pending Approval'
              : o.stage === 'pending' ? 'Pending Order' : o.stage
          )}</span></td>
          <td class="px-3 py-2.5 text-right"><button type="button" onclick="deleteOrder('${escapeHtml(o.id)}')" ${window.printzoneUser?.role === 'User' && o.stage === 'dispatch' ? 'disabled title="This account cannot delete dispatched orders"' : ''} class="danger-action">Delete</button></td>
        </tr>
      `).join('') : '<tr><td colspan="6" class="px-3 py-8 text-center text-slate-500">No orders yet.</td></tr>';

      document.getElementById('pendingApprovalTable').innerHTML = approvalPending.length
        ? approvalPending.map(order => `
          <tr class="hover:bg-white/5">
            <td class="px-3 py-2.5 font-mono text-amber-300">${escapeHtml(order.id)}</td>
            <td class="px-3 py-2.5"><div class="font-bold text-white">${escapeHtml(order.name)}</div><div class="text-[11px] text-slate-400">${escapeHtml(order.partyName)}</div></td>
            <td class="px-3 py-2.5 text-xs text-slate-300">${escapeHtml(order.size)} · ${escapeHtml(order.printingType)} · ${escapeHtml(order.jobType)}</td>
            <td class="px-3 py-2.5 text-right">${Number(order.qty || 0).toLocaleString()}</td>
            <td class="px-3 py-2.5 text-right">${
              ['Admin', 'Manager'].includes(window.printzoneUser?.role)
                ? `<button type="button" onclick="approveOrder('${escapeHtml(order.id)}')" class="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-bold">Final approval</button>`
                : '<span class="text-xs text-amber-300">Awaiting final approval</span>'
            }</td>
          </tr>
        `).join('')
        : '<tr><td colspan="5" class="px-3 py-6 text-center text-slate-400">No orders awaiting approval.</td></tr>';

      // Pending Orders
      document.getElementById('pendingTable').innerHTML = visibleJobs.length ? visibleJobs.map(o => {
        const status = o.printingStatus === 'In Process' ? 'In Progress' : (o.printingStatus || 'Pending');
        const assignmentControl = o.challanNo
          ? `<div class="space-y-1"><button type="button" onclick="openChallanModal('${escapeHtml(o.challanNo)}')" class="font-mono text-cyan-300 hover:underline">${escapeHtml(o.challanNo)}</button><div class="text-[11px] text-slate-400">${escapeHtml(o.vendor || '')}</div><button type="button" onclick="openEditPendingJob('${escapeHtml(o.id)}')" class="px-2 py-1 rounded-lg border text-xs font-bold text-pink-300">Edit job</button></div>`
          : status === 'Done' && o.stage === 'pending'
            ? `<div class="flex flex-wrap gap-1.5 items-center">
                <select id="pendCh-${escapeHtml(o.id)}" class="px-2 py-1 rounded-lg border text-xs">
                  <option value="">Challan</option>
                  ${state.challans.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.id)}</option>`).join('')}
                </select>
                <select id="pendVen-${escapeHtml(o.id)}" class="px-2 py-1 rounded-lg border text-xs">
                  <option value="">Vendor</option>
                  ${state.vendors.map(v => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)}</option>`).join('')}
                </select>
                <button type="button" onclick="punchPendingOrder('${escapeHtml(o.id)}')" class="px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-xs font-bold">Assign</button>
                <button type="button" onclick="openEditPendingJob('${escapeHtml(o.id)}')" class="px-2 py-1 rounded-lg border text-xs font-bold text-pink-300">Edit job</button>
              </div>`
            : `<div class="space-y-1"><span class="text-xs text-slate-400">Awaiting design completion</span><div><button type="button" onclick="openEditPendingJob('${escapeHtml(o.id)}')" class="px-2 py-1 rounded-lg border text-xs font-bold text-pink-300">Edit job</button></div></div>`;
        return `
        <tr class="hover:bg-white/5">
          <td class="px-4 py-3 font-mono text-pink-400">${escapeHtml(o.id)}</td>
          <td class="px-4 py-3"><div class="font-bold text-white">${escapeHtml(o.name)}</div><div class="text-[11px] text-slate-400">${escapeHtml(o.partyName)}</div></td>
          <td class="px-4 py-3 text-xs text-slate-300">${escapeHtml(o.printingType)} &bull; ${escapeHtml(o.jobType)}<div class="mt-1 text-[11px] text-slate-400">${escapeHtml(o.size)}</div></td>
          <td class="px-4 py-3 text-right">${Number(o.qty || 0).toLocaleString()}</td>
          <td class="px-4 py-3">
            <select onchange="updatePendingStatus('${escapeHtml(o.id)}', this.value)" ${o.challanNo ? 'disabled' : ''} class="px-2 py-1 rounded-lg border text-xs">
              <option value="Pending" ${status === 'Pending' ? 'selected' : ''}>Pending</option>
              <option value="In Progress" ${status === 'In Progress' ? 'selected' : ''}>In Progress</option>
              <option value="Done" ${status === 'Done' ? 'selected' : ''}>Done</option>
            </select>
          </td>
          <td class="px-4 py-3">${assignmentControl}</td>
        </tr>
      `;
      }).join('') : `<tr><td colspan="6" class="px-4 py-8 text-center text-slate-400">No jobs in this view.</td></tr>`;

      // Challan Table
      updateChallanPreview();
      updateFilterOptions('challanPartyFilter', 'All parties', [
        ...state.parties.map(party => ({ value: party.id, label: party.name })),
        { value: '__unassigned__', label: 'No linked party' }
      ], challanPartyFilter);
      updateFilterOptions('challanVendorFilter', 'All vendors',
        state.vendors.map(vendor => ({ value: vendor.name, label: vendor.name })),
        challanVendorFilter
      );
      challanPartyFilter = document.getElementById('challanPartyFilter')?.value || 'all';
      challanVendorFilter = document.getElementById('challanVendorFilter')?.value || 'all';
      const visibleChallans = state.challans.filter(challan => {
        const linkedOrders = state.orders.filter(order => order.challanNo === challan.id);
        const matchesParty = challanPartyFilter === 'all'
          || (challanPartyFilter === '__unassigned__'
            ? linkedOrders.length === 0
            : linkedOrders.some(order => order.partyId === challanPartyFilter));
        const matchesVendor = challanVendorFilter === 'all'
          || String(challan.vendor || '').toLowerCase() === challanVendorFilter.toLowerCase();
        return matchesParty && matchesVendor;
      });
      document.getElementById('challansSentCount').textContent =
        state.challans.filter(challan => Boolean(challan.sentDate)).length;
      document.getElementById('challansReceivedCount').textContent =
        state.challans.filter(challan => Boolean(challan.receivedFromVendor)).length;
      document.getElementById('challanTable').innerHTML = visibleChallans.length ? visibleChallans.map(c => {
        const linkedOrders = state.orders.filter(o => o.challanNo === c.id);
        const count = linkedOrders.length;
        const vendorTrips = vendorLedger(c).filter(trip =>
          String(trip.vendor || '').toLowerCase() === String(c.vendor || '').toLowerCase()
        );
        const currentTrip = vendorTrips[vendorTrips.length - 1];
        const sentDate = currentTrip?.sentDate || currentTrip?.incomingDate || c.sentDate || '-';
        return `
        <tr class="hover:bg-white/5">
          <td class="px-4 py-3"><button type="button" onclick="openChallanModal('${escapeHtml(c.id)}')" class="font-mono font-bold text-cyan-300 hover:underline">${escapeHtml(c.id)}</button><div class="mt-1 text-[11px] text-slate-400">Created ${escapeHtml(c.challanDate || '-')}</div></td>
          <td class="px-4 py-3 text-slate-300">${escapeHtml(sentDate)}</td>
          <td class="px-4 py-3 font-semibold text-white">${escapeHtml(c.vendor)}</td>
          <td class="px-4 py-3 text-right font-semibold">${Number(c.paperQty || 0).toLocaleString()}</td>
          <td class="px-4 py-3">${escapeHtml(c.paperSize || '-')}</td>
          <td class="px-4 py-3">${escapeHtml(c.paperType || '-')}</td>
          <td class="px-4 py-3">${Number(c.gsm || 0) || '-'}</td>
          <td class="px-4 py-3 text-center"><span class="px-2 py-0.5 rounded-full text-xs bg-white/10">${count}</span></td>
          <td class="px-4 py-3">${escapeHtml(c.quality || '-')}</td>
          <td class="px-4 py-3 text-xs font-bold text-cyan-300">${escapeHtml(c.status || 'Created')}</td>
          <td class="px-4 py-3 text-right">
            <details class="action-dropdown">
              <summary>Update Status</summary>
              <div class="action-menu">
                <button type="button" onclick="openChallanModal('${escapeHtml(c.id)}')">View details</button>
                <button type="button" onclick="printChallan('${escapeHtml(c.id)}')">Print / Save PDF</button>
                ${c.sentDate ? '' : `<button type="button" onclick="challanAction('${escapeHtml(c.id)}', 'send-challan')">Send challan to vendor</button>`}
                ${c.receivedFromVendor || vendorTrips.some(trip => Number(trip.sentQty || 0) > 0) ? '' : `<button type="button" onclick="challanAction('${escapeHtml(c.id)}', 'sent')">Paper Sent</button>`}
                <button type="button" onclick="challanAction('${escapeHtml(c.id)}', 'forward')">Send to other vendor</button>
                ${c.receivedFromVendor ? '' : `<button type="button" onclick="challanAction('${escapeHtml(c.id)}', 'received')">Mark received at PrintZone</button>`}
                <button type="button" onclick="openEditChallan('${escapeHtml(c.id)}')">Edit challan</button>
                <button type="button" class="danger-action" onclick="deleteChallan('${escapeHtml(c.id)}')">Delete challan</button>
              </div>
            </details>
          </td>
        </tr>`;
      }).join('') : '<tr><td colspan="11" class="px-4 py-8 text-center text-slate-400">No challans match these filters.</td></tr>';

      // Vendors Section
      updateFilterOptions('vendorPartyFilter', 'All parties', [
        ...state.parties.map(party => ({ value: party.id, label: party.name })),
        { value: '__unassigned__', label: 'No linked party' }
      ], vendorPartyFilter);
      updateFilterOptions('vendorFilter', 'All vendors',
        state.vendors.map(vendor => ({ value: vendor.name, label: vendor.name })),
        vendorFilter
      );
      vendorPartyFilter = document.getElementById('vendorPartyFilter')?.value || 'all';
      vendorFilter = document.getElementById('vendorFilter')?.value || 'all';
      const visibleVendors = state.vendors.filter(vendor =>
        vendorFilter === 'all' || vendor.name.toLowerCase() === vendorFilter.toLowerCase()
      );
      document.getElementById('vendorCardsGrid').innerHTML = visibleVendors.length ? visibleVendors.map(v => {
        const allVendorRows = state.challans.flatMap(challan => {
          const currentVendorMatches = String(challan.vendor || '').toLowerCase() === v.name.toLowerCase();
          const ledgerRows = Array.isArray(challan.vendorLedger)
            ? challan.vendorLedger.filter(trip =>
              String(trip.vendor || '').toLowerCase() === v.name.toLowerCase()
            )
            : [];
          if (ledgerRows.length) {
            return ledgerRows.map(trip => ({ challan, trip, isCurrent: currentVendorMatches }));
          }
          if (!currentVendorMatches) return [];
          const isSent = Boolean(
            challan.sentDate
            || challan.receivedFromVendor
            || /^(paper sent|sent to)/i.test(challan.status || '')
          );
          return [{
            challan,
            trip: {
              vendor: challan.vendor,
              sentQty: isSent ? Number(challan.paperQty || 0) : 0,
              receivedQty: challan.receivedFromVendor ? Number(challan.paperQty || 0) : 0,
              incomingQty: 0,
              forwardedQty: 0
            },
            isCurrent: true
          }];
        });
        const vendorRows = allVendorRows.filter(({ challan }) => {
          const linkedOrders = state.orders.filter(order => order.challanNo === challan.id);
          if (vendorPartyFilter === 'all') return true;
          if (vendorPartyFilter === '__unassigned__') return linkedOrders.length === 0;
          return linkedOrders.some(order => order.partyId === vendorPartyFilter);
        });
        const sentRows = vendorRows.filter(row => Number(row.trip.sentQty || 0) > 0);
        const incomingRows = vendorRows.filter(row => Number(row.trip.incomingQty || 0) > 0);
        const returnedRows = vendorRows.filter(row => Number(row.trip.receivedQty || 0) > 0);
        const sentChallanCount = new Set(sentRows.map(row => row.challan.id)).size;
        const incomingChallanCount = new Set(incomingRows.map(row => row.challan.id)).size;
        const returnedChallanCount = new Set(returnedRows.map(row => row.challan.id)).size;
        const sentQuantity = sentRows.reduce((sum, row) => sum + Number(row.trip.sentQty || 0), 0);
        const incomingQuantity = incomingRows.reduce((sum, row) => sum + Number(row.trip.incomingQty || 0), 0);
        const returnedQuantity = returnedRows.reduce((sum, row) => sum + Number(row.trip.receivedQty || 0), 0);
        const withVendorQuantity = vendorRows.reduce((sum, row) => sum + Math.max(
          0,
          Number(row.trip.sentQty || 0)
            + Number(row.trip.incomingQty || 0)
            - Number(row.trip.receivedQty || 0)
            - Number(row.trip.forwardedQty || 0)
        ), 0);
        return `
        <div class="glass-card rounded-2xl p-5 space-y-3">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="font-display font-bold text-lg text-white">${escapeHtml(v.name)}</h3>
              <p class="text-xs text-cyan-300">${escapeHtml(v.role)}</p>
            </div>
            <span class="px-2.5 py-1 rounded-full text-sm font-bold bg-white/10 text-pink-300">${sentChallanCount} sent</span>
          </div>
          <div class="grid grid-cols-2 xl:grid-cols-4 gap-2">
            <div class="vendor-metric"><span>Sent from PrintZone</span><strong>${sentChallanCount} challans</strong><small>${sentQuantity.toLocaleString()} sheets</small></div>
            <div class="vendor-metric"><span>Received from vendor</span><strong>${incomingChallanCount} challans</strong><small>${incomingQuantity.toLocaleString()} sheets</small></div>
            <div class="vendor-metric"><span>Returned to PrintZone</span><strong>${returnedChallanCount} challans</strong><small>${returnedQuantity.toLocaleString()} sheets</small></div>
            <div class="vendor-metric vendor-balance"><span>Still with vendor</span><strong>${withVendorQuantity.toLocaleString()}</strong><small>sheets pending</small></div>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs">
              <thead class="text-slate-400 uppercase">
                <tr>
                  <th class="px-2 py-2">Challan No.</th><th class="px-2 py-2">Vendor</th>
                  <th class="px-2 py-2">Paper Type</th><th class="px-2 py-2">Paper Size</th>
                  <th class="px-2 py-2">GSM</th><th class="px-2 py-2">Printed</th>
                  <th class="px-2 py-2">Received</th><th class="px-2 py-2">Current Status</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-white/10">
            ${vendorRows.map(({ challan: c, trip, isCurrent }) => {
              const sent = Number(trip.sentQty || 0);
              const incoming = Number(trip.incomingQty || 0);
              const returned = Number(trip.receivedQty || 0);
              const forwarded = Number(trip.forwardedQty || 0);
              const balance = Math.max(0, sent + incoming - returned - forwarded);
              const tripStatus = incoming
                ? `Received ${incoming.toLocaleString()} from ${escapeHtml(trip.sourceVendor || 'another vendor')}`
                : returned
                  ? `Returned ${returned.toLocaleString()} to PrintZone`
                  : forwarded
                  ? `Transferred ${forwarded.toLocaleString()} to ${escapeHtml(trip.forwardedTo || 'another vendor')}`
                  : sent
                    ? `With vendor ${balance.toLocaleString()}`
                    : escapeHtml(c.status || 'Not sent yet');
              const linkedOrders = state.orders.filter(order => order.challanNo === c.id);
              const printedCount = linkedOrders.filter(order =>
                ['production', 'dispatch'].includes(order.stage)
              ).length;
              return `
              <tr>
                <td class="px-2 py-2 font-mono font-bold text-cyan-300">${escapeHtml(c.id)}</td>
                <td class="px-2 py-2">${escapeHtml(trip.vendor || c.vendor)}</td>
                <td class="px-2 py-2">${escapeHtml(c.paperType || '-')}</td>
                <td class="px-2 py-2">${escapeHtml(c.paperSize || '-')}</td>
                <td class="px-2 py-2">${Number(c.gsm || 0) || '-'}</td>
                <td class="px-2 py-2">${printedCount}</td>
                <td class="px-2 py-2">${c.receivedFromVendor ? escapeHtml(c.receivedDate || 'Yes') : 'Pending'}</td>
                <td class="px-2 py-2">
                  <span>${tripStatus}</span>
                  ${isCurrent && !c.receivedFromVendor ? `<div class="mt-1 flex gap-1">
                    <button type="button" onclick="challanAction('${escapeHtml(c.id)}', 'forward')" class="px-2 py-1 rounded bg-violet-500/20 text-violet-200 font-bold">Send to other vendor</button>
                    <button type="button" onclick="challanAction('${escapeHtml(c.id)}', 'received')" class="px-2 py-1 rounded bg-emerald-500/20 text-emerald-200 font-bold">Receive at PrintZone</button>
                  </div>` : ''}
                </td>
              </tr>
            `;
            }).join('') || '<tr><td colspan="8" class="px-2 py-4 text-center text-slate-400">No challans for this vendor.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>`;
      }).join('') : '<div class="lg:col-span-2 glass-card p-8 text-center text-sm text-slate-500">No vendors match these filters.</div>';

      // Production Table
      document.getElementById('productionTable').innerHTML = prodOrders.length ? prodOrders.map(o => `
        <tr class="hover:bg-white/5">
          <td class="px-4 py-3"><div class="font-bold text-white">${o.name}</div><div class="text-[11px] text-slate-400">${o.partyName} &bull; ${o.id}</div></td>
          <td class="px-4 py-3 font-mono text-cyan-300">${o.challanNo || '-'}</td>
          ${(() => {
            const stage = currentProductionStage(o);
            const labels = {
              receivedFromVendor: 'Received from Vendor',
              lamination: 'Lamination (optional)',
              cutting: 'Cutting',
              pasting: 'Pasting',
              ready: 'Ready',
              complete: 'Complete'
            };
            const actions = stage === 'lamination'
              ? `<button type="button" onclick="advanceProdStage('${o.id}', 'complete-lamination')">Complete Lamination</button><button type="button" onclick="advanceProdStage('${o.id}', 'skip-lamination')">Skip Lamination</button>`
              : stage === 'complete' || stage === 'receivedFromVendor'
                ? '<span class="menu-empty">Waiting for challan receipt</span>'
                : `<button type="button" onclick="advanceProdStage('${o.id}', '${stage}')">Complete ${labels[stage]}</button>`;
            return `<td class="px-4 py-3"><span class="stage-current">${labels[stage]}</span></td><td class="px-4 py-3"><details class="action-dropdown"><summary>Actions</summary><div class="action-menu">${actions}</div></details></td>`;
          })()}
        </tr>
      `).join('') : `<tr><td colspan="4" class="px-4 py-8 text-center text-slate-400">No orders in Production.</td></tr>`;

      // Dispatch Table
      document.getElementById('dispatchCountAll').textContent = dispatchOrders.length;
      document.getElementById('dispatchCountReady').textContent =
        dispatchOrders.filter(order => (order.dispatch?.status || 'Ready') === 'Ready').length;
      document.getElementById('dispatchCountDispatched').textContent =
        dispatchOrders.filter(order => order.dispatch?.status === 'Dispatched').length;
      document.getElementById('dispatchCountDelivered').textContent =
        dispatchOrders.filter(order => order.dispatch?.status === 'Delivered').length;
      document.getElementById('dispatchTable').innerHTML = visibleDispatchOrders.length ? visibleDispatchOrders.map(o => `
        <tr class="hover:bg-white/5">
          <td class="px-4 py-3 font-mono text-pink-400">${o.id}</td>
          <td class="px-4 py-3"><div class="font-bold text-white">${o.name}</div><div class="text-[11px] text-slate-400">${o.partyName}</div></td>
          <td class="px-4 py-3"><input type="date" value="${o.dispatch.date}" onchange="updateDispatchField('${o.id}', 'date', this.value)" class="px-2 py-1 rounded-lg border text-xs" /></td>
          <td class="px-4 py-3 text-right">${o.qty.toLocaleString()}</td>
          <td class="px-4 py-3"><input type="number" step="0.01" value="${o.dispatch.rate}" onchange="updateDispatchField('${o.id}', 'rate', this.value)" class="w-20 px-2 py-1 rounded-lg border text-xs" /></td>
          <td class="px-4 py-3">
            <select onchange="updateDispatchField('${o.id}', 'status', this.value)" class="px-2 py-1 rounded-lg border text-xs">
              <option value="Ready" ${o.dispatch.status === 'Ready' ? 'selected' : ''}>Ready</option>
              <option value="Dispatched" ${o.dispatch.status === 'Dispatched' ? 'selected' : ''}>Dispatched</option>
              <option value="Delivered" ${o.dispatch.status === 'Delivered' ? 'selected' : ''}>Delivered</option>
            </select>
          </td>
          <td class="px-4 py-3">
            ${o.dispatch.productImg ? `<img src="${o.dispatch.productImg}" alt="Product" class="w-10 h-10 rounded-lg object-cover inline-block mr-2 border border-white/20" />` : ''}
            <label class="cursor-pointer px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-bold">Upload<input type="file" accept="image/*" onchange="uploadOrderImage('${o.id}', 'productImg', this)" class="hidden" /></label>
          </td>
          <td class="px-4 py-3">
            ${attachmentMarkup(o.dispatch.biltyImg, 'Builty')}
            <label class="cursor-pointer inline-flex px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-semibold">${o.dispatch.biltyImg ? 'Replace' : 'Upload receipt'}<input type="file" accept="image/jpeg,image/png,application/pdf" capture="environment" onchange="uploadOrderImage('${o.id}', 'biltyImg', this)" class="hidden" /></label>
          </td>
        </tr>
      `).join('') : `<tr><td colspan="8" class="px-4 py-8 text-center text-slate-400">${dispatchFilter === 'all' ? 'No orders in Dispatch.' : `No ${escapeHtml(dispatchFilter.toLowerCase())} orders.`}</td></tr>`;

      // Accountant
      const dispOnly = dispatchOrders.filter(o => o.dispatch.status === 'Dispatched' || o.dispatch.status === 'Delivered');
      document.getElementById('accountantDispatchTable').innerHTML = dispOnly.map(o => `
        <tr>
          <td class="px-3 py-2"><div class="font-bold text-white">${o.name}</div><div class="text-[11px] text-slate-400">${o.partyName} &bull; ${o.id}</div></td>
          <td class="px-3 py-2 text-right font-bold text-lime-300">&#8377;${(o.qty * o.dispatch.rate).toLocaleString()}</td>
          <td class="px-3 py-2">
            ${attachmentMarkup(o.dispatch.biltyImg, 'Builty')}
            <label class="cursor-pointer px-2.5 py-1 rounded-lg bg-lime-600/30 text-lime-200 text-xs font-bold">Upload Builty<input type="file" accept="image/jpeg,image/png,application/pdf" capture="environment" onchange="uploadOrderImage('${o.id}', 'biltyImg', this)" class="hidden" /></label>
          </td>
        </tr>
      `).join('') || `<tr><td colspan="3" class="px-3 py-6 text-center text-slate-400">No dispatched orders yet.</td></tr>`;

      document.getElementById('tallyTable').innerHTML = state.tallyRows.map(t => `
        <tr>
          <td class="px-3 py-2 text-xs text-slate-400">${t.date}</td>
          <td class="px-3 py-2 font-bold text-white">${t.party}</td>
          <td class="px-3 py-2 text-xs text-cyan-300">${t.voucher}</td>
          <td class="px-3 py-2 text-right font-bold text-emerald-300">&#8377;${Number(t.amount).toLocaleString()}</td>
        </tr>
      `).join('');

      // Paper Stock
      const pNames = [...new Set([
        ...Object.keys(state.paperStock),
        ...Object.keys(state.paperMeta),
        ...Object.keys(state.paperLocations)
      ])];
      const paperOptions = pNames.map(sku => {
        const meta = state.paperMeta[sku] || { paperType: sku, paperSize: '', gsm: 0 };
        const label = `${meta.paperType}${meta.paperSize ? ` · ${meta.paperSize}` : ''}${meta.gsm ? ` · ${meta.gsm} GSM` : ''}`;
        return `<option value="${escapeHtml(sku)}">${escapeHtml(label)}</option>`;
      }).join('');
      ['sendPaperType', 'receivePaperType'].forEach(id => {
        const select = document.getElementById(id);
        const selected = select.value;
        select.innerHTML = `<option value="">Select paper stock</option>${paperOptions}`;
        if (pNames.includes(selected)) select.value = selected;
      });
      ['sendChallan', 'receivePaperChallan'].forEach(id => {
        const select = document.getElementById(id);
        const selected = select.value;
        select.innerHTML = '<option value="">Select challan</option>' + state.challans.map(challan =>
          `<option value="${escapeHtml(challan.id)}">${escapeHtml(challan.id)} · ${escapeHtml(challan.vendor)}</option>`
        ).join('');
        if (state.challans.some(challan => challan.id === selected)) select.value = selected;
      });

      document.getElementById('stockSummaryGrid').innerHTML = pNames.map(p => `
        <div class="glass-card rounded-2xl p-4">
          <p class="text-xs font-bold text-slate-300 uppercase">${escapeHtml(
            (state.paperMeta[p] || {}).paperType || p
          )}</p>
          <p class="text-xs text-slate-400">${escapeHtml((state.paperMeta[p] || {}).paperSize || '')} · ${Number((state.paperMeta[p] || {}).gsm || 0) || '-'} GSM</p>
          <p class="text-2xl font-extrabold ${paperLocationBalance(p, 'Printzone') <= 0 ? 'text-rose-400' : 'text-white'} mt-1">${paperLocationBalance(p, 'Printzone').toLocaleString()}</p>
          <div class="mt-2 pt-2 border-t border-white/10 flex justify-between text-[11px] font-bold">
            <span class="text-emerald-400">Added: +${(state.paperAdded[p] || 0).toLocaleString()}</span>
            <span class="text-rose-400">Sent: -${(state.paperSent[p] || 0).toLocaleString()}</span>
          </div>
        </div>
      `).join('');

      document.getElementById('stockLocationsGrid').innerHTML = STOCK_LOCATIONS.map(location => `
        <div class="rounded-xl border border-white/10 bg-white/5 p-3">
          <h4 class="mb-2 text-sm font-bold text-white">${location}</h4>
          ${pNames.map(sku => `
            <div class="flex justify-between gap-2 border-t border-white/10 py-1.5 text-xs">
              <span class="truncate text-slate-300">${escapeHtml([
                (state.paperMeta[sku] || {}).paperType || sku,
                (state.paperMeta[sku] || {}).paperSize,
                Number((state.paperMeta[sku] || {}).gsm || 0)
                  ? `${Number((state.paperMeta[sku] || {}).gsm)} GSM`
                  : ''
              ].filter(Boolean).join(' · '))}</span>
              <strong class="${paperLocationBalance(sku, location) > 0 ? 'text-emerald-300' : 'text-slate-500'}">${paperLocationBalance(sku, location).toLocaleString()}</strong>
            </div>
          `).join('') || '<p class="text-xs text-slate-400">No paper stock.</p>'}
        </div>
      `).join('');

      document.getElementById('stockFlowTable').innerHTML = state.stockFlow.map((f, i) => `
        <tr>
          <td class="px-3 py-2 text-xs text-slate-400">${i + 1}</td>
          <td class="px-3 py-2"><span class="px-2 py-0.5 rounded-full text-[11px] font-bold ${f.qty >= 0 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}">${escapeHtml(f.type)}</span></td>
          <td class="px-3 py-2 font-bold text-white">${escapeHtml(f.paperType)} · ${escapeHtml(f.paperSize || '')} · ${Number(f.gsm || 0) || '-'} GSM</td>
          <td class="px-3 py-2 text-right font-bold ${f.qty >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${f.qty >= 0 ? '+' : ''}${Number(f.qty || 0).toLocaleString()}</td>
          <td class="px-3 py-2 text-xs text-slate-300">${escapeHtml(f.from || '')} → ${escapeHtml(f.to || '')} · ${escapeHtml(f.note)}</td>
          <td class="px-3 py-2 font-mono text-xs text-cyan-300">${escapeHtml(f.challanNo)}</td>
          <td class="px-3 py-2 text-right font-bold ${Number(f.balanceAfter || 0) <= 0 ? 'text-rose-400' : 'text-white'}">${Number(f.balanceAfter || 0).toLocaleString()}</td>
        </tr>
      `).join('') || '<tr><td colspan="7" class="px-3 py-6 text-center text-slate-400">No paper transfers or receipts recorded.</td></tr>';

      if (window.lucide) lucide.createIcons();
    }

    renderAll();
