(function () {
  const overlay = document.getElementById('loginOverlay');
  const message = document.getElementById('authMessage');
  let resetDetails = null;

  function showMessage(text, tone) {
    message.textContent = text;
    message.className = `text-sm rounded-xl px-3 py-2 ${
      tone === 'error'
        ? 'bg-rose-500/15 border border-rose-400/30 text-rose-200'
        : 'bg-emerald-500/15 border border-emerald-400/30 text-emerald-200'
    }`;
  }

  function clearMessage() {
    message.textContent = '';
    message.className = 'hidden text-sm rounded-xl px-3 py-2';
  }

  function showForm(formId) {
    clearMessage();
    document.querySelectorAll('#loginOverlay form').forEach(form => {
      form.classList.toggle('hidden', form.id !== formId);
    });
  }

  async function api(url, options) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || 'The request could not be completed.');
      error.details = result;
      throw error;
    }
    return result;
  }

  function setRoleAccess(user) {
    const accountantSections = new Set(['dispatch', 'accountant', 'paper-stock']);
    const userSections = new Set([
      'dashboard', 'party-order', 'pending', 'challan', 'vendor', 'production'
    ]);
    const visibleSections = user.role === 'Accountant'
      ? accountantSections
      : user.role === 'User'
        ? userSections
        : new Set([
          'dashboard', 'party-order', 'pending', 'challan', 'vendor',
          'production', 'dispatch', 'accountant', 'paper-stock',
          ...(user.role === 'Admin' ? ['team'] : [])
        ]);
    document.querySelectorAll('.nav-btn[data-section]').forEach(button => {
      const section = button.dataset.section;
      const roleAllowed = visibleSections.has(section);
      const attributeAllowed = !button.dataset.role || button.dataset.role === user.role;
      button.classList.toggle('hidden', !roleAllowed || !attributeAllowed);
    });
    document.querySelectorAll('.section-view').forEach(section => {
      section.classList.toggle('role-hidden', !visibleSections.has(section.id.replace('sec-', '')));
    });
    document.getElementById('signedInUser').textContent =
      `${user.name} · ${user.role} · ${user.team_id}`;
    const firstButton = Array.from(document.querySelectorAll('.nav-btn[data-section]'))
      .find(button => !button.classList.contains('hidden'));
    if (firstButton) firstButton.click();
  }

  async function loadTeam() {
    const result = await api('/api/team');
    const table = document.getElementById('teamMembersTable');
    const escape = value => String(value || '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
    table.innerHTML = result.members.length ? result.members.map(member => `
      <tr>
        <td class="px-4 py-3 font-bold text-white">${escape(member.name)}</td>
        <td class="px-4 py-3">${escape(member.username)}</td>
        <td class="px-4 py-3">${escape(member.role)}</td>
        <td class="px-4 py-3 font-mono text-cyan-300">${escape(member.team_id)}</td>
        <td class="px-4 py-3"><button type="button" data-delete-member="${member.id}" class="text-rose-300 hover:text-rose-200">Remove</button></td>
      </tr>
    `).join('') : '<tr><td colspan="5" class="px-4 py-6 text-center text-slate-400">No team members yet.</td></tr>';
  }

  async function openWorkspace(user) {
    window.printzoneUser = user;
    setRoleAccess(user);
    const stateResult = await api('/api/state');
    if (!stateResult.initialized && ['Admin', 'Manager'].includes(user.role)) {
      await api('/api/state', {
        method: 'POST',
        body: JSON.stringify({
          version: stateResult.version,
          data: window.getInitialState()
        })
      });
      const seeded = await api('/api/state');
      window.setAppState(seeded.data, seeded.version);
    } else {
      window.setAppState(stateResult.data, stateResult.version);
    }
    if (user.role === 'Admin') {
      await loadTeam();
    }
    overlay.classList.add('hidden');
  }

  document.querySelectorAll('.auth-switch').forEach(button => {
    button.addEventListener('click', () => showForm(button.dataset.authForm));
  });

  document.getElementById('loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    clearMessage();
    try {
      const result = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          identifier: document.getElementById('loginIdentifier').value.trim(),
          password: document.getElementById('loginPassword').value
        })
      });
      if (result.user.role === 'Customer') {
        window.location.href = '/track';
        return;
      }
      await openWorkspace(result.user);
    } catch (error) {
      showMessage(error.message, 'error');
    }
  });

  document.getElementById('registerForm').addEventListener('submit', async event => {
    event.preventDefault();
    clearMessage();
    try {
      const result = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('registerName').value.trim(),
          username: document.getElementById('registerUsername').value.trim(),
          email: document.getElementById('registerEmail').value.trim(),
          phone: document.getElementById('registerPhone').value.trim(),
          password: document.getElementById('registerPassword').value
        })
      });
      document.getElementById('loginIdentifier').value =
        document.getElementById('registerEmail').value.trim();
      showForm('loginForm');
      showMessage(result.message || 'Account created. Sign in to continue.', 'success');
    } catch (error) {
      showMessage(error.message, 'error');
    }
  });

  document.getElementById('resetRequestForm').addEventListener('submit', async event => {
    event.preventDefault();
    clearMessage();
    resetDetails = {
      method: document.getElementById('resetMethod').value,
      identifier: document.getElementById('resetIdentifier').value.trim()
    };
    try {
      const result = await api('/api/auth/request-reset', {
        method: 'POST',
        body: JSON.stringify(resetDetails)
      });
      showForm('resetConfirmForm');
      showMessage(result.message, 'success');
    } catch (error) {
      showMessage(error.message, 'error');
    }
  });

  document.getElementById('resetConfirmForm').addEventListener('submit', async event => {
    event.preventDefault();
    clearMessage();
    try {
      const result = await api('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          ...resetDetails,
          code: document.getElementById('resetCode').value.trim(),
          password: document.getElementById('resetNewPassword').value
        })
      });
      showForm('loginForm');
      showMessage(result.message, 'success');
    } catch (error) {
      showMessage(error.message, 'error');
    }
  });

  document.getElementById('teamMemberForm').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await api('/api/team', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('teamName').value.trim(),
          username: document.getElementById('teamUsername').value.trim(),
          email: document.getElementById('teamEmail').value.trim(),
          phone: document.getElementById('teamPhone').value.trim(),
          password: document.getElementById('teamPassword').value,
          team_id: document.getElementById('teamId').value.trim(),
          role: document.getElementById('teamRole').value
        })
      });
      event.target.reset();
      await loadTeam();
      showToast('Team account created.', 'emerald');
    } catch (error) {
      showToast(error.message, 'rose');
    }
  });

  document.getElementById('teamMembersTable').addEventListener('click', async event => {
    const button = event.target.closest('[data-delete-member]');
    if (!button || !window.confirm('Remove this team member?')) return;
    try {
      await api(`/api/team?id=${encodeURIComponent(button.dataset.deleteMember)}`, {
        method: 'DELETE'
      });
      await loadTeam();
      showToast('Team member removed.', 'emerald');
    } catch (error) {
      showToast(error.message, 'rose');
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
      window.printzoneUser = null;
      window.location.reload();
    } catch (error) {
      showToast(error.message, 'rose');
    }
  });

  (async function restoreSession() {
    try {
      const result = await api('/api/auth/me');
      if (result.user) {
        if (result.user.role === 'Customer') {
          window.location.href = '/track';
          return;
        }
        await openWorkspace(result.user);
      }
    } catch (error) {
      showMessage('Sign in or create an account to access the workspace.', 'success');
    }
  })();
})();
