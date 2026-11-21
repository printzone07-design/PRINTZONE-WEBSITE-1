const message = document.getElementById('trackMessage');
const resultPanel = document.getElementById('trackResult');

async function loadCustomerOrders() {
  try {
    const response = await fetch('/api/customer/orders');
    const data = await response.json();
    if (response.status === 401) {
      window.location.href = '/';
      return;
    }
    if (!response.ok) throw new Error(data.error || 'Unable to load your orders.');

    resultPanel.replaceChildren();
    if (!data.orders.length) {
      message.textContent = 'No orders are currently linked to this registered email.';
      return;
    }

    message.textContent = '';
    data.orders.forEach(order => {
      const card = document.createElement('article');
      card.className = 'rounded-2xl border border-white/10 bg-white/5 p-4 space-y-2';
      const title = document.createElement('h2');
      title.className = 'font-bold text-white';
      title.textContent = `${order.id} — ${order.name}`;
      card.appendChild(title);
      [
        ['Quantity', Number(order.quantity).toLocaleString()],
        ['Production', order.printing_status || order.stage || 'In process'],
        ['Dispatch', order.dispatch_status || 'Not dispatched'],
        ['Dispatch date', order.dispatch_date || 'Not dispatched']
      ].forEach(([label, value]) => {
        const row = document.createElement('p');
        row.className = 'flex justify-between gap-4 text-sm';
        const key = document.createElement('span');
        key.className = 'text-slate-400';
        key.textContent = label;
        const content = document.createElement('strong');
        content.className = 'text-white text-right';
        content.textContent = value == null ? '-' : String(value);
        row.append(key, content);
        card.appendChild(row);
      });
      resultPanel.appendChild(card);
    });
  } catch (error) {
    message.textContent = error.message;
    message.className = 'text-center text-sm rounded-xl p-3 bg-rose-500/15 border border-rose-400/30 text-rose-200';
  }
}

document.getElementById('customerLogout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
});

loadCustomerOrders();
