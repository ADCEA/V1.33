// ============================================================
// Blanchisserie Cézanne — frontend
// Toutes les données transitent par l'API (/api/...) et sont
// stockées côté serveur dans la base SQLite. Rien n'est conservé
// dans le navigateur au-delà du cookie de session.
// ============================================================

const STATUSES = [
  { id: 'recue', label: 'Reçue' },
  { id: 'traitement', label: 'En traitement' },
  { id: 'prete', label: 'Prête' },
  { id: 'livree', label: 'Livrée' },
];
function statusLabel(id) { return (STATUSES.find(s => s.id === id) || {}).label || id; }

let SERVICES = [];
let CATEGORIES = [];
let cart = {};
let currentClient = null;
let adminUnlocked = false;
let ownOrdersCache = [];
let adminOrdersCache = [];

// ---------- appel API ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* pas de corps JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Erreur ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------- catalogue ----------
async function loadServices() {
  const { services, categories } = await api('GET', '/api/services');
  SERVICES = services;
  CATEGORIES = categories || [];
}

// Regroupe SERVICES par catégorie, dans l'ordre défini par CATEGORIES.
// Les articles sans catégorie connue atterrissent dans un groupe "Autres".
function groupedServices() {
  const groups = CATEGORIES.map(c => ({ ...c, items: [] }));
  const others = { id: '_autres', label: 'Autres', items: [] };
  SERVICES.forEach(s => {
    const group = groups.find(g => g.id === s.category);
    (group || others).items.push(s);
  });
  return others.items.length ? [...groups, others] : groups;
}

function renderHomeServices() {
  const el = document.getElementById('home-services');
  if (!el) return;
  el.innerHTML = groupedServices().map(group => `
    <div class="catalog-group">
      <h4 class="catalog-group-title">${group.label}</h4>
      <div class="home-services">
        ${group.items.map(s => `
          <div class="home-service-card">
            <div class="service-badge">${s.code}</div>
            <div>${s.name}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function renderServiceList() {
  const el = document.getElementById('service-list');
  el.innerHTML = groupedServices().map(group => `
    <div class="service-group">
      <h5 class="service-group-title">${group.label}</h5>
      ${group.items.map(s => {
        const qty = cart[s.id] || 0;
        return `
        <div class="service-row">
          <div class="service-id">
            <div class="service-badge">${s.code}</div>
            <div class="service-name">${s.name}</div>
          </div>
          <div class="qty-control">
            <button data-act="dec" data-id="${s.id}" aria-label="Diminuer">−</button>
            <input type="number" class="qty-input" inputmode="numeric" min="0" id="qty-${s.id}" data-id="${s.id}" value="${qty}">
            <button data-act="inc" data-id="${s.id}" aria-label="Augmenter">+</button>
          </div>
        </div>
      `;
      }).join('')}
    </div>
  `).join('');
  el.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const cur = cart[id] || 0;
      cart[id] = btn.dataset.act === 'inc' ? cur + 1 : Math.max(0, cur - 1);
      renderServiceList();
      renderSummary();
    });
  });
  el.querySelectorAll('input.qty-input').forEach(input => {
    // "input" plutôt que "change" : la quantité et le récap se mettent à
    // jour au fil de la frappe, sans attendre que le champ perde le focus.
    input.addEventListener('input', () => {
      const id = input.dataset.id;
      const val = parseInt(input.value, 10);
      cart[id] = Number.isInteger(val) && val >= 0 ? val : 0;
      renderSummary();
    });
    // Au départ du champ, on nettoie l'affichage (ex. champ vidé -> "0").
    input.addEventListener('blur', () => { renderServiceList(); });
  });
}

function renderSummary() {
  const lines = Object.entries(cart).filter(([, q]) => q > 0);
  const box = document.getElementById('summary-lines');
  const btn = document.getElementById('btn-submit');
  if (lines.length === 0) {
    box.innerHTML = '<p class="empty-note">Aucun article sélectionné pour le moment.</p>';
    btn.disabled = true;
    return;
  }
  box.innerHTML = lines.map(([id, q]) => {
    const s = SERVICES.find(x => x.id === id);
    return `<div class="summary-line"><span>${s.name} × ${q}</span></div>`;
  }).join('');
  btn.disabled = false;
}

function showFormError(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('show', Boolean(message));
}

// ---------- soumission de commande ----------
document.getElementById('btn-submit').addEventListener('click', async () => {
  showFormError('order-error', '');
  const societe = document.getElementById('f-societe').value.trim();
  const contact = document.getElementById('f-contact').value.trim();
  const tel = document.getElementById('f-tel').value.trim();
  const livraisonPrevue = document.getElementById('f-livraison').value;
  const adresse = document.getElementById('f-adresse').value.trim();
  const notes = document.getElementById('f-notes').value.trim();

  if (!societe || !contact || !tel || !adresse) {
    showFormError('order-error', 'Merci de renseigner société, contact, téléphone et adresse.');
    return;
  }
  const items = Object.entries(cart).filter(([, q]) => q > 0).map(([id, qty]) => ({ id, qty }));
  if (items.length === 0) {
    showFormError('order-error', 'Merci de sélectionner au moins un article.');
    return;
  }

  const btn = document.getElementById('btn-submit');
  btn.disabled = true; btn.textContent = 'Enregistrement...';

  try {
    const { order } = await api('POST', '/api/orders', {
      items,
      livraisonPrevue,
      notes,
      client: { societe, contact, tel, adresse },
    });

    showConfirmation(order);
    cart = {};
    ['f-societe', 'f-contact', 'f-tel', 'f-livraison', 'f-adresse', 'f-notes'].forEach(id => document.getElementById(id).value = '');
    renderServiceList();
    renderSummary();
    switchView('confirmation');
  } catch (err) {
    showFormError('order-error', err.message || "Une erreur est survenue, merci de réessayer.");
  } finally {
    btn.disabled = false; btn.textContent = 'Valider la commande';
  }
});

function showConfirmation(order) {
  document.getElementById('confirm-ticket').innerHTML = `
    <div class="ticket-top">
      <div>
        <div class="ticket-eyebrow">Commande enregistrée</div>
        <div class="ticket-num">${order.ticket}</div>
      </div>
      <span class="ticket-status ${order.status}">${statusLabel(order.status)}</span>
    </div>
    <div class="ticket-dash"></div>
    ${order.items.map(i => `<div class="ticket-item"><span>${i.name} × ${i.qty}</span></div>`).join('')}
    <div class="ticket-meta">
      ${order.client.societe} — ${order.client.contact}<br>
      Livraison prévue : ${order.livraisonPrevue || 'à confirmer'}<br>
      Conservez ce numéro pour suivre votre commande.
    </div>
  `;
}
document.getElementById('btn-new-order').addEventListener('click', () => switchView('commander'));

// ---------- comptes clients ----------
document.querySelectorAll('.auth-toggle button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auth-toggle button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    document.getElementById('form-' + btn.dataset.auth).classList.add('active');
    clearAuthErrors();
  });
});
function showAuthError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.classList.add('show');
}
function clearAuthErrors() {
  document.querySelectorAll('.auth-error').forEach(e => { e.classList.remove('show'); e.textContent = ''; });
}

document.getElementById('btn-register').addEventListener('click', async () => {
  clearAuthErrors();
  const societe = document.getElementById('reg-societe').value.trim();
  const contact = document.getElementById('reg-contact').value.trim();
  const tel = document.getElementById('reg-tel').value.trim();
  const adresse = document.getElementById('reg-adresse').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const code = document.getElementById('reg-code').value.trim();
  const code2 = document.getElementById('reg-code2').value.trim();

  if (code !== code2) { showAuthError('err-inscription', 'Les deux codes ne correspondent pas.'); return; }

  try {
    const { client } = await api('POST', '/api/clients/register', { societe, contact, tel, adresse, email, code });
    currentClient = client;
    ['reg-societe', 'reg-contact', 'reg-tel', 'reg-adresse', 'reg-email', 'reg-code', 'reg-code2'].forEach(id => document.getElementById(id).value = '');
    await renderEspace();
  } catch (err) {
    showAuthError('err-inscription', err.message);
  }
});

document.getElementById('btn-login').addEventListener('click', async () => {
  clearAuthErrors();
  const email = document.getElementById('login-email').value.trim();
  const code = document.getElementById('login-code').value.trim();
  try {
    const { client } = await api('POST', '/api/clients/login', { email, code });
    currentClient = client;
    document.getElementById('login-email').value = '';
    document.getElementById('login-code').value = '';
    await renderEspace();
  } catch (err) {
    showAuthError('err-connexion', err.message);
  }
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await api('POST', '/api/clients/logout');
  currentClient = null;
  renderEspace();
});

document.getElementById('btn-espace-new-order').addEventListener('click', () => {
  switchView('commander');
});

// Pré-remplit le formulaire de commande avec les coordonnées du compte
// connecté, sans écraser ce que l'utilisateur a déjà commencé à taper.
function prefillOrderFormIfLoggedIn() {
  if (!currentClient) return;
  const societeField = document.getElementById('f-societe');
  if (societeField.value.trim()) return; // déjà rempli / en cours de saisie, on ne touche pas
  societeField.value = currentClient.societe;
  document.getElementById('f-contact').value = currentClient.contact;
  document.getElementById('f-tel').value = currentClient.tel;
  document.getElementById('f-adresse').value = currentClient.adresse;
}

async function renderNpsCard() {
  const zone = document.getElementById('nps-card');
  const { alreadyResponded } = await api('GET', '/api/clients/nps/status');
  if (alreadyResponded) { zone.innerHTML = ''; return; }

  let selectedScore = null;

  zone.innerHTML = `
    <div class="nps-card">
      <h4>Un avis rapide ?</h4>
      <p>
        Sur une échelle de 0 à 10, recommanderiez-vous Blanchisserie Cézanne à un confrère hôtelier ?
        <button type="button" class="nps-dismiss" id="nps-dismiss">Plus tard</button>
      </p>
      <div class="nps-scale">
        ${Array.from({ length: 11 }, (_, i) => `<button type="button" data-score="${i}">${i}</button>`).join('')}
      </div>
      <div class="nps-scale-labels"><span>Peu probable</span><span>Très probable</span></div>
      <textarea id="nps-comment" placeholder="Un commentaire à ajouter ? (optionnel)" style="display:none;"></textarea>
      <button class="btn-secondary" id="nps-submit" style="width:auto;display:none;">Envoyer</button>
    </div>
  `;

  document.getElementById('nps-dismiss').addEventListener('click', () => { zone.innerHTML = ''; });

  zone.querySelectorAll('[data-score]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedScore = Number(btn.dataset.score);
      zone.querySelectorAll('[data-score]').forEach(b => b.classList.toggle('selected', b === btn));
      document.getElementById('nps-comment').style.display = 'block';
      document.getElementById('nps-submit').style.display = 'inline-block';
    });
  });

  document.getElementById('nps-submit').addEventListener('click', async () => {
    if (selectedScore === null) return;
    const comment = document.getElementById('nps-comment').value.trim();
    try {
      await api('POST', '/api/clients/nps', { score: selectedScore, comment });
      zone.innerHTML = '<div class="nps-card"><p class="nps-thanks">Merci pour votre retour ✓</p></div>';
      setTimeout(() => { zone.innerHTML = ''; }, 3000);
    } catch (err) {
      alert(err.message);
    }
  });
}

async function renderOwnInvoices() {
  const section = document.getElementById('own-invoices-section');
  const box = document.getElementById('own-invoices');
  const { invoices } = await api('GET', '/api/clients/invoices');
  if (invoices.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  box.innerHTML = invoices.map(inv => `
    <div class="own-ticket" style="display:flex;justify-content:space-between;align-items:center;">
      <div>
        <span class="mini-num">${inv.odooNumber || 'Facture #' + inv.id}</span>
        <span class="mini-sub">${new Date(inv.periodStart).toLocaleDateString('fr-FR')} au ${new Date(inv.periodEnd).toLocaleDateString('fr-FR')} · ${inv.totalHt?.toFixed(2)} € HT</span>
      </div>
      <a href="/api/clients/invoices/${inv.id}/pdf" target="_blank" style="color:var(--brand);text-decoration:underline;font-size:12.5px;white-space:nowrap;margin-left:10px;">Télécharger</a>
    </div>
  `).join('');
}

async function renderEspace() {
  const authBox = document.getElementById('espace-auth');
  const dash = document.getElementById('espace-dashboard');
  clearAuthErrors();
  if (!currentClient) {
    authBox.style.display = 'block';
    dash.style.display = 'none';
    return;
  }
  authBox.style.display = 'none';
  dash.style.display = 'block';
  document.getElementById('dash-societe').textContent = currentClient.societe;
  document.getElementById('dash-email').textContent = currentClient.email;

  renderNpsCard();

  document.getElementById('billing-siret').value = currentClient.siret || '';
  document.getElementById('billing-tva').value = currentClient.tvaNumber || '';
  document.getElementById('billing-adresse').value = currentClient.adresseFacturation || '';

  renderOwnInvoices();

  const { orders } = await api('GET', '/api/clients/orders');
  ownOrdersCache = orders;
  const box = document.getElementById('own-orders');
  if (orders.length === 0) {
    box.innerHTML = '<p class="empty-note">Aucune commande pour le moment.</p>';
    return;
  }
  box.innerHTML = orders.map(o => {
    const adjusted = o.items.some(i => (i.deliveredQty ?? i.qty) !== i.qty);
    return `
    <div class="own-ticket ${o.status}" data-id="${o.id}" tabindex="0" role="button" aria-label="Voir le détail de la commande ${o.ticket}">
      <div>
        <span class="mini-num">${o.ticket}</span>
        <span class="mini-sub">${o.items.length} réf. · ${new Date(o.createdAt).toLocaleDateString('fr-FR')}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        ${adjusted ? '<span class="adjusted-flag" title="Quantités livrées différentes de la commande">Ajustée</span>' : ''}
        <span class="own-badge ${o.status}">${statusLabel(o.status)}</span>
      </div>
    </div>
  `;
  }).join('');
  box.querySelectorAll('.own-ticket').forEach(el => {
    el.addEventListener('click', () => openOrderModal(el.dataset.id, 'espace'));
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOrderModal(el.dataset.id, 'espace'); } });
  });
}
document.getElementById('btn-save-billing').addEventListener('click', async () => {
  const note = document.getElementById('billing-note');
  try {
    const { client } = await api('PUT', '/api/clients/me/billing', {
      siret: document.getElementById('billing-siret').value.trim(),
      tvaNumber: document.getElementById('billing-tva').value.trim(),
      adresseFacturation: document.getElementById('billing-adresse').value.trim(),
    });
    currentClient = client;
    note.classList.remove('error');
    note.style.color = 'var(--teal)';
    note.textContent = 'Enregistré ✓';
    note.classList.add('show');
    setTimeout(() => note.classList.remove('show'), 2500);
  } catch (err) {
    note.classList.add('error');
    note.textContent = err.message;
  }
});

// ---------- modal aperçu commande ----------
const ADMIN_MODAL_CONTEXTS = ['kanban', 'production', 'logistics', 'historique'];
let currentModalContext = null;

async function openOrderModal(orderId, context) {
  currentModalContext = context;
  const order = ownOrdersCache.find(o => String(o.id) === String(orderId)) || adminOrdersCache.find(o => String(o.id) === String(orderId));
  if (!order) return;
  const currentIdx = STATUSES.findIndex(s => s.id === order.status);
  const isAdminContext = ADMIN_MODAL_CONTEXTS.includes(context);
  const editableQty = isAdminContext && order.status === 'traitement';

  const itemsHtml = editableQty
    ? order.items.map(i => `
        <div class="modal-qty-row">
          <div>
            <div>${i.name}</div>
            <div class="modal-qty-ordered-hint">Commandé : ${i.qty}</div>
          </div>
          <div class="modal-qty-control">
            <input type="number" class="modal-qty-input" id="modal-qty-${i.id}" min="0" value="${i.deliveredQty ?? i.qty}">
            <span class="modal-qty-hint">livré</span>
          </div>
        </div>
      `).join('')
    : order.items.map(i => {
        const delivered = i.deliveredQty ?? i.qty;
        if (delivered === i.qty) {
          return `<div class="ticket-item"><span>${i.name} × ${i.qty}</span></div>`;
        }
        return `
          <div class="ticket-item-adjusted">
            <div class="item-name">${i.name}</div>
            <div class="qty-compare-line">
              <span class="qty-ordered">${i.qty} commandé</span>
              <span class="qty-delivered">${delivered} livré</span>
            </div>
          </div>
        `;
      }).join('');

  document.getElementById('modal-ticket').innerHTML = `
    <div class="ticket-top">
      <div>
        <div class="ticket-eyebrow">Commande</div>
        <div class="ticket-num">${order.ticket}</div>
      </div>
      <span class="ticket-status ${order.status}">${statusLabel(order.status)}</span>
    </div>
    <div class="ticket-dash"></div>
    ${itemsHtml}
    ${editableQty ? `
      <button class="btn-secondary" id="btn-save-qty" style="width:100%;margin-top:12px;">Enregistrer les quantités livrées</button>
      <div class="qty-save-note" id="qty-save-note"></div>
    ` : ''}
    <div class="timeline" style="margin-top:22px;">
      ${STATUSES.map((s, i) => `
        <div class="tl-step ${i < currentIdx ? 'done' : ''} ${i === currentIdx ? 'current' : ''}">
          <div class="tl-dot">${i < currentIdx ? '✓' : i + 1}</div>
          <div class="tl-label">${s.label}</div>
        </div>
      `).join('')}
    </div>
    <div class="ticket-meta">
      ${order.client.societe} — ${order.client.contact}<br>
      ${order.client.adresse}<br>
      ${isAdminContext ? '' : `Livraison prévue : ${order.livraisonPrevue || 'non précisée'}<br>`}
      Commande passée le ${new Date(order.createdAt).toLocaleDateString('fr-FR')}
      ${order.notes ? `<br>Notes : ${order.notes}` : ''}
    </div>
    ${isAdminContext ? `
      <div class="field-row" style="margin-top:10px;align-items:end;">
        <div class="field" style="max-width:200px;"><label>Livraison prévue</label><input type="date" id="modal-livraison-prevue" value="${order.livraisonPrevue || ''}"></div>
        <button class="btn-secondary" id="btn-save-livraison-prevue" style="width:auto;">Enregistrer</button>
        <span class="qty-save-note" id="livraison-prevue-note"></span>
      </div>
    ` : ''}
  `;
  if (isAdminContext) {
    document.getElementById('btn-save-livraison-prevue').addEventListener('click', async () => {
      const note = document.getElementById('livraison-prevue-note');
      try {
        await api('PATCH', `/api/admin/orders/${order.id}/livraison-prevue`, { livraisonPrevue: document.getElementById('modal-livraison-prevue').value });
        note.classList.remove('error');
        note.style.color = 'var(--teal)';
        note.textContent = 'Enregistré ✓';
      } catch (err) {
        note.classList.add('error');
        note.textContent = err.message;
      }
    });
  }
  if (editableQty) {
    document.getElementById('btn-save-qty').addEventListener('click', () => saveModalQuantities(order.id));
  }

  const noteBox = document.getElementById('modal-delivery-note');
  if (isAdminContext) {
    noteBox.style.display = 'block';
    noteBox.innerHTML = `
      <p style="font-size:12.5px;color:var(--steel);margin:0 0 12px;">Génère le bon de livraison et tente de l'envoyer par email à l'adresse configurée dans les réglages.</p>
      <button class="btn-mail" id="btn-send-delivery">Générer le bon de livraison</button>
      <div class="modal-actions-note" id="delivery-status-note"></div>
    `;
    document.getElementById('btn-send-delivery').addEventListener('click', () => sendDeliveryNote(order.id));
  } else {
    noteBox.style.display = 'none';
    noteBox.innerHTML = '';
  }

  const teamZone = document.getElementById('modal-team-zone');
  if (context === 'production' || context === 'logistics') {
    teamZone.style.display = 'block';
    teamZone.innerHTML = '<p style="font-size:12.5px;color:var(--steel-light);">Chargement…</p>';
    renderTeamZone(order.id, context);
  } else {
    teamZone.style.display = 'none';
    teamZone.innerHTML = '';
  }

  const conditioningZone = document.getElementById('modal-conditioning-zone');
  if (context === 'kanban' || context === 'production') {
    conditioningZone.style.display = 'block';
    conditioningZone.innerHTML = `
      <h4 class="card-subhead" style="margin-bottom:8px;">Organisation du conditionnement</h4>
      <p style="font-size:12px;color:var(--steel);margin:0 0 8px;">Répartir les articles de cette commande dans les chariots choisis.</p>
      <button class="btn-secondary" id="btn-open-conditioning" style="width:auto;">Organiser le conditionnement</button>
      <div id="conditioning-zone-${order.id}" data-open="false"></div>
    `;
    document.getElementById('btn-open-conditioning').addEventListener('click', () => openConditioningUI(order.id));
  } else {
    conditioningZone.style.display = 'none';
    conditioningZone.innerHTML = '';
  }

  const manageZone = document.getElementById('modal-order-manage-zone');
  if (isAdminContext) {
    manageZone.style.display = 'block';
    manageZone.innerHTML = `
      <h4 class="card-subhead" style="margin-bottom:8px;">Gestion de la commande</h4>
      <button class="btn-secondary" id="btn-open-add-item" style="width:auto;margin-right:8px;">+ Ajouter un article</button>
      <button class="btn-secondary" id="btn-delete-order" style="width:auto;color:var(--rust);border-color:var(--rust);">Supprimer la commande</button>
      <div id="add-item-zone-${order.id}" style="margin-top:10px;"></div>
    `;
    document.getElementById('btn-open-add-item').addEventListener('click', () => openAddItemUI(order.id));
    document.getElementById('btn-delete-order').addEventListener('click', () => deleteOrder(order.id, order.ticket));
  } else {
    manageZone.style.display = 'none';
    manageZone.innerHTML = '';
  }

  document.getElementById('order-modal').classList.add('open');
}

async function openAddItemUI(orderId) {
  const zone = document.getElementById(`add-item-zone-${orderId}`);
  if (!zone) return;
  if (zone.dataset.open === 'true') { zone.innerHTML = ''; zone.dataset.open = 'false'; return; }
  zone.dataset.open = 'true';

  const { articles } = await api('GET', '/api/admin/articles');
  zone.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:10px;">
      <div class="field-row" style="align-items:end;">
        <div class="field">
          <label>Article</label>
          <select id="add-item-select-${orderId}">
            ${articles.map(a => `<option value="${a.id}">${a.name}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="max-width:100px;">
          <label>Quantité</label>
          <input type="number" min="1" value="1" id="add-item-qty-${orderId}">
        </div>
        <button class="btn-primary" id="btn-confirm-add-item-${orderId}" style="width:auto;">Ajouter</button>
      </div>
      <div class="qty-save-note" id="add-item-note-${orderId}"></div>
    </div>
  `;
  document.getElementById(`btn-confirm-add-item-${orderId}`).addEventListener('click', async () => {
    const serviceId = document.getElementById(`add-item-select-${orderId}`).value;
    const qty = document.getElementById(`add-item-qty-${orderId}`).value;
    const note = document.getElementById(`add-item-note-${orderId}`);
    try {
      const { order } = await api('POST', `/api/admin/orders/${orderId}/items`, { serviceId, qty });
      const cacheIdx = adminOrdersCache.findIndex(o => String(o.id) === String(orderId));
      if (cacheIdx !== -1) adminOrdersCache[cacheIdx] = order;
      zone.innerHTML = '';
      zone.dataset.open = 'false';
      openOrderModal(orderId, currentModalContext); // ré-ouvre pour afficher la commande à jour
    } catch (err) {
      note.classList.add('error');
      note.textContent = err.message;
    }
  });
}

async function deleteOrder(orderId, ticket) {
  if (!confirm(`Supprimer définitivement la commande ${ticket} ? Cette action est irréversible.`)) return;
  await api('DELETE', `/api/admin/orders/${orderId}`);
  document.getElementById('order-modal').classList.remove('open');
  // Rafraîchit la vue actuellement affichée, quelle qu'elle soit.
  if (currentModalContext === 'production') renderProductionKanban();
  else if (currentModalContext === 'logistics') renderLogisticsView();
  else if (currentModalContext === 'historique') renderHistoryList();
  else refreshAdmin();
}

// Échappement HTML minimal — le texte des messages et les noms d'auteurs
// viennent de saisie libre (chauffeurs, équipe), jamais interpolés tels
// quels dans le rendu.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Rend une liste de commentaires en bulles façon iMessage : messages des
// livreurs (author se terminant par "(livreur)", voir driverPortal.js) à
// gauche en gris, reste de l'équipe à droite en bleu. Les messages
// consécutifs du même auteur sont regroupés — une seule légende
// (nom + heure) pour tout le groupe, pas une par bulle.
function renderCommentsThread(comments) {
  if (comments.length === 0) return '<p class="imsg-empty">Aucun message pour le moment.</p>';

  const groups = [];
  for (const c of comments) {
    const last = groups[groups.length - 1];
    if (last && last.author === (c.author || 'Anonyme')) last.items.push(c);
    else groups.push({ author: c.author || 'Anonyme', items: [c] });
  }

  return `<div class="imsg-thread">${groups.map(g => {
    const isDriver = g.author.endsWith('(livreur)');
    const side = isDriver ? 'in' : 'out';
    const displayName = isDriver ? g.author.replace(/\s*\(livreur\)$/, '') : g.author;
    const firstTime = new Date(g.items[0].createdAt).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `
      <div class="imsg-group">
        <div class="imsg-caption ${side}">${escapeHtml(displayName)} · ${firstTime}</div>
        ${g.items.map(c => `
          <div class="imsg-row ${side}">
            <div class="imsg-bubble ${side}">${escapeHtml(c.text)}</div>
          </div>
        `).join('')}
      </div>
    `;
  }).join('')}</div>`;
}

async function renderTeamZone(orderId, context) {
  const teamZone = document.getElementById('modal-team-zone');
  const { extraClients, comments } = await api('GET', `/api/admin/orders/${orderId}/extra`);
  const showExtraClients = context === 'production';
  if (showExtraClients && manualOrderClientsCache.length === 0) {
    const { clients } = await api('GET', '/api/admin/clients');
    manualOrderClientsCache = clients;
  }
  const selectedIds = new Set(extraClients.map(c => c.id));

  teamZone.innerHTML = `
    ${showExtraClients ? `
      <p style="font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:var(--steel);margin:0 0 8px;font-weight:500;">Hôtels supplémentaires associés</p>
      <p style="font-size:11.5px;color:var(--steel-light);margin:0 0 10px;">Utile si ce lot mélange le linge de plusieurs établissements.</p>
      <div id="extra-clients-list" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
        ${manualOrderClientsCache.map(c => `
          <label class="driver-chip" style="cursor:pointer;">
            <input type="checkbox" value="${c.id}" ${selectedIds.has(c.id) ? 'checked' : ''} style="margin-right:4px;">
            ${c.societe}
          </label>
        `).join('')}
      </div>
      <button class="btn-secondary" id="btn-save-extra-clients" style="width:auto;">Enregistrer</button>
      <div class="qty-save-note" id="extra-clients-note"></div>
    ` : ''}

    <p style="font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:var(--steel);margin:${showExtraClients ? '20px' : '0'} 0 8px;font-weight:500;">Discussion équipe${context === 'logistics' ? ' (inclut les messages des livreurs)' : ''}</p>
    <div id="comments-list" style="max-height:260px;overflow-y:auto;margin-bottom:10px;padding:4px 6px;">
      ${renderCommentsThread(comments)}
    </div>
    <div class="field-row">
      <div class="field" style="flex:0 0 120px;"><label>Votre nom</label><input id="comment-author" placeholder="Optionnel"></div>
      <div class="field"><label>Message</label><input id="comment-text" placeholder="Écrire un message…"></div>
    </div>
    <button class="btn-secondary" id="btn-add-comment" style="width:auto;">Envoyer</button>
  `;

  if (showExtraClients) {
    document.getElementById('btn-save-extra-clients').addEventListener('click', async () => {
      const clientIds = [...teamZone.querySelectorAll('#extra-clients-list input:checked')].map(i => i.value);
      const note = document.getElementById('extra-clients-note');
      try {
        await api('PUT', `/api/admin/orders/${orderId}/extra-clients`, { clientIds });
        note.style.color = 'var(--teal)';
        note.textContent = 'Enregistré ✓';
      } catch (err) {
        note.classList.add('error');
        note.textContent = err.message;
      }
    });
  }

  document.getElementById('btn-add-comment').addEventListener('click', async () => {
    const author = document.getElementById('comment-author').value.trim();
    const text = document.getElementById('comment-text').value.trim();
    if (!text) return;
    await api('POST', `/api/admin/orders/${orderId}/comments`, { author, text });
    renderTeamZone(orderId, context);
  });
  document.getElementById('comment-text').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-add-comment').click();
  });
}

async function saveModalQuantities(orderId) {
  const note = document.getElementById('qty-save-note');
  const order = adminOrdersCache.find(o => String(o.id) === String(orderId));
  if (!order) return;

  const items = order.items.map(i => {
    const input = document.getElementById('modal-qty-' + i.id);
    const raw = input ? parseInt(input.value, 10) : i.deliveredQty;
    return { id: i.id, deliveredQty: Number.isInteger(raw) && raw >= 0 ? raw : i.deliveredQty };
  });

  const refreshByContext = {
    kanban: refreshAdmin,
    production: renderProductionKanban,
    logistics: renderLogisticsKanban,
    historique: renderHistoryList,
  };

  try {
    await api('PATCH', `/api/admin/orders/${orderId}/items`, { items });
    await (refreshByContext[currentModalContext] || refreshAdmin)();
    await openOrderModal(orderId, currentModalContext || 'kanban');
    const freshNote = document.getElementById('qty-save-note');
    if (freshNote) freshNote.textContent = 'Quantités livrées mises à jour ✓';
  } catch (err) {
    if (note) { note.textContent = err.message; note.classList.add('error'); }
  }
}

function buildMailtoFallback(to, subject, text) {
  return `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}

// Génère le même PDF que le serveur, mais côté navigateur — utilisé quand
// le SMTP n'est pas configuré, puisque mailto: ne peut pas joindre de fichier.
function downloadDeliveryNotePdf(order) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 18;
  let hasAdjustedItem = false;

  // en-tête : texte + un seul filet de couleur, pas de bandeau plein
  doc.setTextColor(29, 145, 255); // accent (unique touche de couleur)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text('BLANCHISSERIE CÉZANNE', marginX, 16);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(100, 121, 141);
  doc.text('Du linge propre, livré dans les temps.', marginX, 22);
  doc.setDrawColor(29, 145, 255);
  doc.setLineWidth(0.5);
  doc.line(marginX, 27, pageWidth - marginX, 27);

  let y = 40;
  doc.setTextColor(100, 121, 141);
  doc.setFontSize(9); doc.text('BON DE LIVRAISON', marginX, y);
  y += 8;
  doc.setTextColor(22, 50, 79);
  doc.setFont('courier', 'bold'); doc.setFontSize(17);
  doc.text(order.ticket, marginX, y);
  y += 8;

  // statut : cadre à contour, pas de fond plein — imprimable sans encre couleur
  const label = statusLabel(order.status).toUpperCase();
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
  const labelWidth = doc.getTextWidth(label) + 8;
  doc.setDrawColor(22, 50, 79); doc.setLineWidth(0.3);
  doc.roundedRect(marginX, y - 4, labelWidth, 6, 3, 3, 'S');
  doc.setTextColor(22, 50, 79);
  doc.text(label, marginX + labelWidth / 2, y, { align: 'center' });
  y += 10;

  doc.setDrawColor(185, 196, 206);
  doc.setLineDashPattern([1, 1], 0);
  doc.line(marginX, y, pageWidth - marginX, y);
  doc.setLineDashPattern([], 0);
  y += 8;

  doc.setTextColor(22, 50, 79); doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
  doc.text(`${order.client.societe} — ${order.client.contact}`, marginX, y);
  y += 6;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(100, 121, 141);
  doc.text(order.client.adresse, marginX, y);
  y += 6;
  doc.text(`Tél : ${order.client.tel}  ·  Livraison prévue : ${order.livraisonPrevue || 'à confirmer'}`, marginX, y);
  y += 10;

  doc.setDrawColor(185, 196, 206);
  doc.setLineDashPattern([1, 1], 0);
  doc.line(marginX, y, pageWidth - marginX, y);
  doc.setLineDashPattern([], 0);
  y += 8;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(100, 121, 141);
  doc.text('ARTICLE', marginX, y);
  doc.text('COMMANDÉ', pageWidth - marginX - 45, y, { align: 'right' });
  doc.text('LIVRÉ', pageWidth - marginX, y, { align: 'right' });
  y += 4;
  doc.setDrawColor(22, 50, 79);
  doc.setLineWidth(0.3);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 6;

  order.items.forEach(i => {
    const delivered = i.deliveredQty ?? i.qty;
    const diff = delivered !== i.qty;
    if (diff) hasAdjustedItem = true;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(22, 50, 79);
    doc.text(i.name, marginX, y);
    doc.setTextColor(100, 121, 141);
    doc.text(String(i.qty), pageWidth - marginX - 45, y, { align: 'right' });
    // Une quantité ajustée se distingue par le gras + un astérisque,
    // pas par la couleur seule — reste lisible imprimé en N&B.
    doc.setFont('helvetica', diff ? 'bold' : 'normal');
    doc.setTextColor(22, 50, 79);
    doc.text(diff ? `${delivered} *` : String(delivered), pageWidth - marginX, y, { align: 'right' });
    y += 7;
  });

  if (hasAdjustedItem) {
    y += 2;
    doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(100, 121, 141);
    doc.text('* quantité livrée différente de la quantité commandée', marginX, y);
    y += 6;
  }

  if (order.notes) {
    y += 4;
    doc.setDrawColor(185, 196, 206);
    doc.setLineDashPattern([1, 1], 0);
    doc.line(marginX, y, pageWidth - marginX, y);
    doc.setLineDashPattern([], 0);
    y += 7;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(100, 121, 141);
    doc.text('NOTES', marginX, y);
    y += 5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(22, 50, 79);
    doc.text(order.notes, marginX, y, { maxWidth: pageWidth - marginX * 2 });
  }

  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(100, 121, 141);
  doc.text(`Généré le ${new Date().toLocaleDateString('fr-FR')} — Blanchisserie Cézanne`, marginX, doc.internal.pageSize.getHeight() - 12);

  doc.save(`bon-livraison-${order.ticket}.pdf`);
}

async function sendDeliveryNote(orderId) {
  const note = document.getElementById('delivery-status-note');
  const order = adminOrdersCache.find(o => String(o.id) === String(orderId));
  try {
    const result = await api('POST', `/api/admin/orders/${orderId}/delivery-note`);
    if (result.sent) {
      if (note) note.textContent = `Email envoyé à ${result.to}, PDF joint ✓`;
      return;
    }
    if (result.reason === 'no_email') {
      if (note) note.textContent = "Merci de renseigner d'abord votre email dans « Réglages — Bons de livraison » en haut de l'espace administration.";
      return;
    }
    if (result.reason === 'smtp_not_configured') {
      if (order) downloadDeliveryNotePdf(order);
      if (note) note.innerHTML = `Envoi automatique non configuré côté serveur (voir .env). Le PDF a été téléchargé — <a href="${buildMailtoFallback(result.to, 'Bon de livraison ' + (order ? order.ticket : ''), result.text)}" style="color:var(--brand);text-decoration:underline;">ouvrez votre messagerie</a> et joignez-le manuellement.`;
    }
  } catch (err) {
    if (note) note.textContent = err.message || "Échec de l'envoi.";
  }
}

function closeOrderModal() {
  document.getElementById('order-modal').classList.remove('open');
}
document.getElementById('modal-close').addEventListener('click', closeOrderModal);
document.getElementById('order-modal').addEventListener('click', e => {
  if (e.target.id === 'order-modal') closeOrderModal();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeOrderModal(); });

// ---------- administration ----------
document.getElementById('btn-admin-setup').addEventListener('click', async () => {
  clearAuthErrors();
  const p1 = document.getElementById('admin-pwd-new').value;
  const p2 = document.getElementById('admin-pwd-new2').value;
  if (p1 !== p2) { showAuthError('err-admin', 'Les deux mots de passe ne correspondent pas.'); return; }
  try {
    await api('POST', '/api/admin/setup', { password: p1 });
    adminUnlocked = true;
    document.getElementById('admin-pwd-new').value = '';
    document.getElementById('admin-pwd-new2').value = '';
    await renderAdminGate();
  } catch (err) {
    showAuthError('err-admin', err.message);
  }
});

document.getElementById('btn-admin-login').addEventListener('click', async () => {
  clearAuthErrors();
  const password = document.getElementById('admin-pwd').value;
  try {
    await api('POST', '/api/admin/login', { password });
    adminUnlocked = true;
    document.getElementById('admin-pwd').value = '';
    await renderAdminGate();
  } catch (err) {
    showAuthError('err-admin', err.message);
  }
});

document.getElementById('btn-admin-lock').addEventListener('click', async () => {
  await api('POST', '/api/admin/logout');
  adminUnlocked = false;
  renderAdminGate();
});

async function renderAdminGate() {
  clearAuthErrors();
  const gate = document.getElementById('admin-gate');
  const dash = document.getElementById('admin-dashboard');

  const status = await api('GET', '/api/admin/status');
  adminUnlocked = status.unlocked;

  if (adminUnlocked) {
    gate.style.display = 'none';
    dash.style.display = 'block';
    refreshAdmin(); // peuple aussi les compteurs "Commandes totales / En cours", toujours visibles
    switchAdminView('production');
    return;
  }
  gate.style.display = 'block';
  dash.style.display = 'none';
  document.getElementById('admin-gate-setup').style.display = status.exists ? 'none' : 'block';
  document.getElementById('admin-gate-login').style.display = status.exists ? 'block' : 'none';
}

async function renderSettingsPanel() {
  const { deliveryEmail } = await api('GET', '/api/admin/settings');
  document.getElementById('settings-email').value = deliveryEmail || '';

  const { truckCapacityKg, cartWeightKg, avgSpeedKmh, minutesPerStop, maxCartWeightKg, prioritizeGrouping } = await api('GET', '/api/admin/articles/logistics-settings');
  document.getElementById('settings-truck-capacity').value = truckCapacityKg;
  document.getElementById('settings-cart-weight').value = cartWeightKg;
  document.getElementById('settings-avg-speed').value = avgSpeedKmh;
  document.getElementById('settings-minutes-per-stop').value = minutesPerStop;
  document.getElementById('settings-max-cart-weight').value = maxCartWeightKg;
  document.getElementById('rules-max-weight-echo').textContent = maxCartWeightKg;
  document.getElementById('settings-prioritize-grouping').checked = prioritizeGrouping !== 0;

  const { address } = await api('GET', '/api/admin/logistics/depot');
  document.getElementById('settings-depot-address').value = address || '';
}
document.getElementById('btn-save-depot').addEventListener('click', async () => {
  const note = document.getElementById('logistics-settings-save-note');
  try {
    await api('PUT', '/api/admin/logistics/depot', { address: document.getElementById('settings-depot-address').value.trim() });
    note.classList.remove('error');
    note.style.color = 'var(--teal)';
    note.textContent = 'Adresse enregistrée ✓';
    note.classList.add('show');
    setTimeout(() => note.classList.remove('show'), 2500);
  } catch (err) {
    note.classList.add('error');
    note.textContent = err.message;
    note.classList.add('show');
  }
});
document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const deliveryEmail = document.getElementById('settings-email').value.trim();
  await api('PUT', '/api/admin/settings', { deliveryEmail });
  const note = document.getElementById('settings-save-note');
  note.classList.add('show');
  setTimeout(() => note.classList.remove('show'), 2500);
});
async function saveLogisticsSettings(noteId) {
  const note = document.getElementById(noteId);
  try {
    await api('PUT', '/api/admin/articles/logistics-settings', {
      truckCapacityKg: document.getElementById('settings-truck-capacity').value,
      cartWeightKg: document.getElementById('settings-cart-weight').value,
      avgSpeedKmh: document.getElementById('settings-avg-speed').value,
      minutesPerStop: document.getElementById('settings-minutes-per-stop').value,
      maxCartWeightKg: document.getElementById('settings-max-cart-weight').value,
      prioritizeGrouping: document.getElementById('settings-prioritize-grouping').checked,
    });
    document.getElementById('rules-max-weight-echo').textContent = document.getElementById('settings-max-cart-weight').value;
    note.classList.remove('error');
    note.style.color = 'var(--teal)';
    note.textContent = 'Enregistré ✓';
    note.classList.add('show');
    setTimeout(() => note.classList.remove('show'), 2500);
  } catch (err) {
    note.classList.add('error');
    note.textContent = err.message;
    note.classList.add('show');
  }
}
document.getElementById('btn-save-logistics-settings').addEventListener('click', () => saveLogisticsSettings('logistics-settings-save-note'));
document.getElementById('btn-save-grouping-strategy').addEventListener('click', () => saveLogisticsSettings('grouping-strategy-save-note'));

async function loadOdooTaxesIntoSelect(selectedId) {
  const select = document.getElementById('settings-odoo-tax');
  const note = document.getElementById('odoo-settings-save-note');
  try {
    const { taxes } = await api('GET', '/api/admin/odoo/taxes');
    select.innerHTML = '<option value="">— Aucune —</option>' +
      taxes.map(t => `<option value="${t.id}" ${String(t.id) === String(selectedId) ? 'selected' : ''}>${t.name} (${t.amount}%)</option>`).join('');
  } catch (err) {
    note.classList.add('error');
    note.textContent = `Impossible de charger les taxes depuis Odoo : ${err.message}`;
  }
}
document.getElementById('btn-refresh-odoo-taxes').addEventListener('click', () => loadOdooTaxesIntoSelect());
document.getElementById('btn-save-odoo-settings').addEventListener('click', async () => {
  const note = document.getElementById('odoo-settings-save-note');
  try {
    await api('PUT', '/api/admin/odoo/settings', { odooTaxId: document.getElementById('settings-odoo-tax').value || null });
    note.classList.remove('error');
    note.style.color = 'var(--teal)';
    note.textContent = 'Enregistré ✓';
    note.classList.add('show');
    setTimeout(() => note.classList.remove('show'), 2500);
  } catch (err) {
    note.classList.add('error');
    note.textContent = err.message;
  }
});

let kanbanDateFilter = '';

async function refreshAdmin() {
  const [{ orders }] = await Promise.all([
    api('GET', '/api/admin/orders'),
    ensureCartTypesCache(),
  ]);
  adminOrdersCache = orders;
  document.getElementById('stat-total').textContent = orders.length;
  document.getElementById('stat-cours').textContent = orders.filter(o => o.status !== 'livree').length;

  renderKanbanBody();
}

async function changeOrderStatus(orderId, newStatus) {
  const orderBefore = adminOrdersCache.find(o => String(o.id) === String(orderId));
  await api('PATCH', `/api/admin/orders/${orderId}/status`, { status: newStatus });

  if (newStatus === 'livree' && orderBefore) {
    const missing = orderBefore.items.filter(it => (it.deliveredQty ?? it.qty) < it.qty);
    if (missing.length > 0) {
      const detail = missing.map(it => `${it.name} (manque ${it.qty - (it.deliveredQty ?? it.qty)})`).join(', ');
      const wantsFollowup = confirm(
        `Cette commande n'a pas été livrée en totalité :\n${detail}\n\nCréer une commande de complément pour demain avec ces manquants ?`
      );
      if (wantsFollowup) {
        try {
          const { order: followup } = await api('POST', `/api/admin/orders/${orderId}/create-followup`, {});
          alert(`Commande de complément créée : ${followup.ticket} (livraison prévue le ${followup.livraisonPrevue}).`);
        } catch (err) {
          alert(`Impossible de créer la commande de complément : ${err.message}`);
        }
      }
    }
  }

  refreshAdmin();
}

function renderKanbanBody() {
  const orders = kanbanDateFilter
    ? adminOrdersCache.filter(o => o.livraisonPrevue && o.livraisonPrevue <= kanbanDateFilter)
    : adminOrdersCache;

  const kanban = document.getElementById('kanban');
  kanban.innerHTML = STATUSES.map(st => {
    const fullList = orders.filter(o => o.status === st.id);
    const isLivree = st.id === 'livree';
    const list = isLivree ? fullList.slice(0, 10) : fullList;
    return `
      <div class="kcol" data-status="${st.id}">
        <div class="kcol-head"><h4>${st.label}</h4><span class="kcol-count">${fullList.length}</span></div>
        <div class="kcol-drop">
        ${list.length === 0 ? '<div class="kcol-empty">Aucune commande</div>' : list.map(o => `
          <div class="mini-ticket ${o.status}" data-id="${o.id}" draggable="true" tabindex="0" role="button" aria-label="Voir le détail de la commande ${o.ticket}">
            <div class="mini-num">${o.ticket}</div>
            <div class="mini-client">${o.client.societe}</div>
            <div class="mini-sub">${o.items.length} réf.</div>
            ${st.id !== 'livree' ? `<button class="mini-advance" data-id="${o.id}">Faire avancer →</button>` : ''}
          </div>
        `).join('')}
        </div>
        ${isLivree && fullList.length > 10 ? `<button class="kcol-history-link" id="btn-open-history">Voir tout l'historique (${fullList.length}) →</button>` : ''}
      </div>
    `;
  }).join('');

  const historyLink = document.getElementById('btn-open-history');
  if (historyLink) historyLink.addEventListener('click', () => switchAdminView('historique'));

  kanban.querySelectorAll('.mini-ticket').forEach(el => {
    el.addEventListener('click', () => openOrderModal(el.dataset.id, 'kanban'));
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOrderModal(el.dataset.id, 'kanban'); } });
    el.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', el.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });
  kanban.querySelectorAll('.mini-advance').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const order = adminOrdersCache.find(o => String(o.id) === String(btn.dataset.id));
      const idx = STATUSES.findIndex(s => s.id === order.status);
      if (idx < STATUSES.length - 1) {
        await changeOrderStatus(order.id, STATUSES[idx + 1].id);
      }
    });
  });

  // glisser-déposer : chaque colonne accepte une carte, dans n'importe quel sens
  kanban.querySelectorAll('.kcol').forEach(col => {
    col.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', e => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
    });
    col.addEventListener('drop', async e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const orderId = e.dataTransfer.getData('text/plain');
      const newStatus = col.dataset.status;
      const order = adminOrdersCache.find(o => String(o.id) === String(orderId));
      if (!order || order.status === newStatus) return;
      await changeOrderStatus(orderId, newStatus);
    });
  });
}
document.getElementById('kanban-date-filter').addEventListener('change', e => {
  kanbanDateFilter = e.target.value;
  renderKanbanBody();
});
document.getElementById('btn-clear-kanban-date-filter').addEventListener('click', () => {
  kanbanDateFilter = '';
  document.getElementById('kanban-date-filter').value = '';
  renderKanbanBody();
});

// ---------- sous-menu admin : file de production / historique ----------
// ---------- Production (étapes de lavage) ----------
const PRODUCTION_STAGES = [
  { id: 'tri', label: 'Tri' },
  { id: 'lavage', label: 'Lavage' },
  { id: 'sechage', label: 'Séchage' },
  { id: 'repassage', label: 'Repassage' },
  { id: 'pliage', label: 'Pliage / emballage' },
  { id: 'en_stock', label: 'En stock' },
];

async function renderProductionTotals() {
  const { totals } = await api('GET', '/api/admin/production/totals');
  const el = document.getElementById('production-totals');
  if (totals.length === 0) {
    el.innerHTML = '<p class="empty-note">Rien à préparer pour le moment.</p>';
    return;
  }
  const maxQty = Math.max(...totals.map(t => t.totalQty));
  el.innerHTML = totals.map(t => `
    <div class="stats-row">
      <span><span class="mini-badge" style="margin-right:8px;">${t.code}</span>${t.name}</span>
      <span class="stats-row-bar"><span class="stats-row-bar-fill" style="width:${(t.totalQty / maxQty) * 100}%;"></span></span>
      <span class="mono" style="font-weight:600;">${t.totalQty}</span>
    </div>
  `).join('');
}

let productionItemsCache = [];
let productionHotelFilter = '';
let productionDateFilter = '';

async function renderProductionKanban() {
  const [{ orders }, { items }] = await Promise.all([
    api('GET', '/api/admin/production/orders'),
    api('GET', '/api/admin/production/items'),
    renderProductionTotals(),
  ]);
  adminOrdersCache = orders; // pour que openOrderModal('production') retrouve la commande complète au clic
  productionItemsCache = items;

  populateProductionHotelFilter(items);
  renderProductionKanbanBody();
}

function populateProductionHotelFilter(items) {
  const select = document.getElementById('production-hotel-filter');
  const hotels = [...new Set(items.map(i => i.societe))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="">— Tous les hôtels —</option>' +
    hotels.map(h => `<option value="${h}" ${h === productionHotelFilter ? 'selected' : ''}>${h}</option>`).join('');
}
document.getElementById('production-hotel-filter').addEventListener('change', e => {
  productionHotelFilter = e.target.value;
  renderProductionKanbanBody();
});
document.getElementById('production-date-filter').addEventListener('change', e => {
  productionDateFilter = e.target.value;
  renderProductionKanbanBody();
});
document.getElementById('btn-clear-production-date-filter').addEventListener('click', () => {
  productionDateFilter = '';
  document.getElementById('production-date-filter').value = '';
  renderProductionKanbanBody();
});

const PRODUCTION_STAGE_COLORS = ['var(--rust)', 'var(--amber)', 'var(--brand)', 'var(--brand-deep)', 'var(--teal)', 'var(--ink)'];

function renderProductionProgress(items) {
  const zone = document.getElementById('production-progress');
  if (items.length === 0) {
    zone.innerHTML = '';
    return;
  }
  const totalQty = items.reduce((sum, i) => sum + i.qty, 0);
  const stageIndex = Object.fromEntries(PRODUCTION_STAGES.map((s, idx) => [s.id, idx]));
  const maxIndex = PRODUCTION_STAGES.length - 1;

  const weightedSum = items.reduce((sum, i) => sum + i.qty * ((stageIndex[i.productionStage || 'tri'] ?? 0) / maxIndex), 0);
  const progressPct = totalQty > 0 ? Math.round((weightedSum / totalQty) * 100) : 0;

  const segments = PRODUCTION_STAGES.map((s, idx) => {
    const qtyInStage = items.filter(i => (i.productionStage || 'tri') === s.id).reduce((sum, i) => sum + i.qty, 0);
    return { ...s, qtyInStage, pct: totalQty > 0 ? (qtyInStage / totalQty) * 100 : 0, color: PRODUCTION_STAGE_COLORS[idx] };
  });

  zone.innerHTML = `
    <div class="progress-card">
      <div class="progress-card-head">
        <span>Taux d'avancement${productionHotelFilter ? ' — ' + productionHotelFilter : ''}</span>
        <b>${progressPct}%</b>
      </div>
      <div class="progress-bar">
        ${segments.filter(s => s.pct > 0).map(s => `<span style="width:${s.pct}%;background:${s.color};"></span>`).join('')}
      </div>
      <div class="progress-legend">
        ${segments.map(s => `<span><em style="background:${s.color};"></em>${s.label} : ${s.qtyInStage}</span>`).join('')}
      </div>
    </div>
  `;
}

function renderProductionKanbanBody() {
  let items = productionHotelFilter
    ? productionItemsCache.filter(i => i.societe === productionHotelFilter)
    : productionItemsCache;
  if (productionDateFilter) {
    items = items.filter(i => i.livraisonPrevue && i.livraisonPrevue <= productionDateFilter);
  }

  renderProductionProgress(items);

  const kanban = document.getElementById('production-kanban');
  kanban.innerHTML = PRODUCTION_STAGES.map(stage => {
    const list = items.filter(i => (i.productionStage || 'tri') === stage.id);
    return `
      <div class="kcol" data-stage="${stage.id}">
        <div class="kcol-head"><h4>${stage.label}</h4><span class="kcol-count">${list.length}</span></div>
        <div class="kcol-drop">
        ${list.length === 0 ? '<div class="kcol-empty">Aucun article</div>' : list.map(i => `
          <div class="mini-ticket traitement" data-item-id="${i.id}" data-order-id="${i.orderId}" draggable="true" tabindex="0" role="button" aria-label="${i.name}, commande ${i.ticket}">
            <div class="mini-num">${i.name} <span class="mono" style="font-weight:600;">×${i.qty}</span></div>
            <div class="mini-client">${i.societe}</div>
            <div class="mini-sub">${i.ticket}</div>
          </div>
        `).join('')}
        </div>
      </div>
    `;
  }).join('');

  kanban.querySelectorAll('.mini-ticket').forEach(el => {
    el.addEventListener('click', () => openOrderModal(el.dataset.orderId, 'production'));
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOrderModal(el.dataset.orderId, 'production'); } });
    el.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', el.dataset.itemId);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });

  kanban.querySelectorAll('.kcol').forEach(col => {
    col.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', e => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
    });
    col.addEventListener('drop', async e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const itemId = e.dataTransfer.getData('text/plain');
      const newStage = col.dataset.stage;
      const item = productionItemsCache.find(i => String(i.id) === String(itemId));
      if (!item || item.productionStage === newStage) return;
      await api('PATCH', `/api/admin/production/items/${itemId}/stage`, { stage: newStage });
      renderProductionKanban();
    });
  });
}

// ---------- Logistique livraison (chauffeurs) ----------
let driversCache = [];
let logisticsOrdersCache = [];

async function renderLogisticsView() {
  await ensureCartTypesCache();
  await renderTruckTypesList();
  await renderDriversList();
  await renderLogisticsKanban();
}

async function renderDriversList() {
  const { drivers } = await api('GET', '/api/admin/logistics/drivers');
  driversCache = drivers;
  const list = document.getElementById('drivers-list');
  if (drivers.length === 0) {
    list.innerHTML = '<p class="empty-note">Aucun chauffeur enregistré pour le moment.</p>';
  } else {
    list.innerHTML = drivers.map(d => {
      const truck = truckTypesCache.find(t => t.id === d.truck_type_id);
      return `
      <span class="driver-chip">
        ${d.name}${d.vehicle ? ` <span class="driver-vehicle">— ${d.vehicle}</span>` : ''}${truck ? ` <span class="driver-vehicle">(${truck.name})</span>` : ''}
        <button data-copy-link="${d.access_token}" aria-label="Copier le lien de sa tournée" title="Copier le lien de sa tournée">🔗</button>
        <button data-delete-driver="${d.id}" aria-label="Retirer ce chauffeur">✕</button>
      </span>
    `;
    }).join('');
    list.querySelectorAll('[data-delete-driver]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Retirer ce chauffeur ? Ses commandes assignées repasseront "non assignées".')) return;
        await api('DELETE', `/api/admin/logistics/drivers/${btn.dataset.deleteDriver}`);
        renderLogisticsView();
      });
    });
    list.querySelectorAll('[data-copy-link]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const url = `${window.location.origin}/tournee.html?token=${btn.dataset.copyLink}`;
        try {
          await navigator.clipboard.writeText(url);
          btn.textContent = '✓';
          setTimeout(() => { btn.textContent = '🔗'; }, 1500);
        } catch {
          prompt('Copiez ce lien pour le chauffeur :', url);
        }
      });
    });
  }
}

document.getElementById('btn-add-driver').addEventListener('click', async () => {
  const name = document.getElementById('new-driver-name').value.trim();
  const vehicle = document.getElementById('new-driver-vehicle').value.trim();
  const truckTypeId = document.getElementById('new-driver-truck-type').value || null;
  if (!name) return;
  await api('POST', '/api/admin/logistics/drivers', { name, vehicle, truckTypeId });
  document.getElementById('new-driver-name').value = '';
  document.getElementById('new-driver-vehicle').value = '';
  document.getElementById('new-driver-truck-type').value = '';
  renderLogisticsView();
});

async function openConditioningUI(orderId) {
  const zone = document.getElementById(`conditioning-zone-${orderId}`);
  if (!zone) return;
  if (zone.dataset.open === 'true') { zone.innerHTML = ''; zone.dataset.open = 'false'; return; }
  zone.dataset.open = 'true';
  await ensureCartTypesCache();

  zone.innerHTML = `
    <div style="background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:10px;margin-top:10px;">
      <p style="font-size:11px;color:var(--steel);margin:0 0 8px;">Choisissez les chariots utilisés pour cette commande :</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
        ${cartTypesCache.map(c => `
          <div style="display:flex;align-items:center;gap:4px;">
            <label style="font-size:11px;">${c.name}</label>
            <input type="number" min="0" value="0" data-cart-type-id="${c.id}" style="width:44px;border:1px solid var(--line);border-radius:4px;padding:3px;font-size:11px;text-align:center;">
          </div>
        `).join('')}
      </div>
      <button class="btn-primary" id="btn-calc-conditioning-${orderId}" style="width:auto;padding:6px 12px;font-size:11px;">Calculer la répartition</button>
      <div id="conditioning-result-${orderId}" style="margin-top:10px;"></div>
    </div>
  `;

  document.getElementById(`btn-calc-conditioning-${orderId}`).addEventListener('click', async () => {
    const inputs = zone.querySelectorAll(`[data-cart-type-id]`);
    const cartSelection = [...inputs]
      .map(i => ({ cartTypeId: Number(i.dataset.cartTypeId), count: parseInt(i.value, 10) || 0 }))
      .filter(s => s.count > 0);
    const resultZone = document.getElementById(`conditioning-result-${orderId}`);
    if (cartSelection.length === 0) {
      resultZone.innerHTML = '<p class="empty-note">Choisissez au moins un chariot.</p>';
      return;
    }
    resultZone.innerHTML = '<p style="font-size:11px;color:var(--steel-light);">Calcul…</p>';
    try {
      const plan = await api('POST', '/api/admin/logistics/pack', { orderId, cartSelection });
      resultZone.innerHTML = `
        ${plan.carts.map(c => `
          <div style="background:var(--paper);border:1px solid var(--line);border-radius:5px;padding:8px 10px;margin-bottom:6px;">
            <div style="font-weight:600;font-size:12px;color:var(--ink);">${c.name} — ${c.usedL} / ${c.capacityL} L · <span style="color:${c.usedKg >= c.maxWeightKg ? 'var(--rust)' : 'var(--steel)'};">${c.usedKg} / ${c.maxWeightKg} kg${c.usedKg >= c.maxWeightKg ? ' ⚠️ limite poids atteinte' : ''}</span></div>
            ${c.items.length === 0 ? '<div style="font-size:11px;color:var(--steel-light);">Vide</div>' : `
              <div style="font-size:10px;color:var(--steel-light);margin:4px 0 3px;">Ordre de chargement — le plus lourd d'abord, au fond du chariot :</div>
              ${c.items.map((i, idx) => `
                <div style="font-size:11px;color:var(--steel);">${idx + 1}. ${i.name} × ${i.qty}${idx === 0 ? ' <span style="color:var(--steel-light);">(fond)</span>' : ''}</div>
              `).join('')}
            `}
          </div>
        `).join('')}
        ${plan.unpacked.length > 0 ? `
          <div style="background:var(--paper);border:1.5px solid var(--rust);border-radius:5px;padding:8px 10px;">
            <div style="font-weight:600;font-size:12px;color:var(--rust);">⚠️ Ne rentre pas, ajoutez un chariot :</div>
            ${plan.unpacked.map(i => `<div style="font-size:11px;color:var(--rust);">• ${i.name} × ${i.qty}</div>`).join('')}
          </div>
        ` : '<p style="font-size:11px;color:var(--teal);font-weight:600;">✓ Tout tient dans les chariots choisis.</p>'}
        <button class="btn-secondary" id="btn-print-conditioning-${orderId}" style="width:auto;margin-top:10px;padding:6px 12px;font-size:11px;">🖨️ Bon de préparation (PDF)</button>
      `;
      document.getElementById(`btn-print-conditioning-${orderId}`).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Génération…';
        try {
          const res = await fetch('/api/admin/logistics/pack/pdf', {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId, cartSelection }),
          });
          if (!res.ok) throw new Error((await res.json()).error || 'Échec de la génération du PDF.');
          const blob = await res.blob();
          window.open(URL.createObjectURL(blob), '_blank');
        } catch (err) {
          alert(err.message);
        } finally {
          btn.disabled = false;
          btn.textContent = '🖨️ Bon de préparation (PDF)';
        }
      });
    } catch (err) {
      resultZone.innerHTML = `<p style="font-size:11px;color:var(--rust);">${err.message}</p>`;
    }
  });
}

async function runRouteOptimization(driverId) {
  const resultZone = document.getElementById(`route-result-${driverId || 'none'}`);
  if (!resultZone) return;
  resultZone.innerHTML = '<p style="font-size:11px;color:var(--steel-light);">Calcul en cours (géocodage des adresses, peut prendre quelques secondes)…</p>';
  try {
    const { route, failed } = await api('POST', '/api/admin/logistics/optimize-route', { driverId });
    if (route.length === 0) {
      resultZone.innerHTML = failed.length > 0
        ? `<p style="font-size:11px;color:var(--rust);">⚠️ Adresse non localisée, impossible de calculer l'itinéraire pour : ${failed.map(f => `${f.ticket} (${f.adresse})`).join(', ')}. Vérifiez que l'adresse est correctement orthographiée.</p>`
        : '<p class="empty-note">Aucune commande prête à organiser.</p>';
      return;
    }
    resultZone.innerHTML = `
      <div style="background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:8px 10px;margin-bottom:10px;font-size:11px;">
        ${route.map(s => `
          <div style="padding:4px 0;border-bottom:1px solid var(--line);">
            <b>#${s.sequence}</b> ${s.societe} — ${s.ticket}
            ${s.distanceFromPrevKm != null ? `<span style="color:var(--steel-light);"> (+${s.distanceFromPrevKm} km)</span>` : ''}
          </div>
        `).join('')}
        ${failed.length > 0 ? `
          <div style="margin-top:8px;color:var(--rust);">⚠️ Adresse(s) non localisée(s), ordre non calculé pour :
            ${failed.map(f => `${f.ticket} (${f.adresse})`).join(', ')}
          </div>
        ` : ''}
      </div>
      <p style="font-size:10.5px;color:var(--steel-light);">Les numéros d'ordre apparaîtront sur les étiquettes au prochain rafraîchissement de cet écran.</p>
    `;
  } catch (err) {
    resultZone.innerHTML = `<p style="font-size:11px;color:var(--rust);">${err.message}</p>`;
  }
}

async function renderLogisticsKanban() {
  const [{ orders }, { loads, settings }] = await Promise.all([
    api('GET', '/api/admin/logistics/orders'),
    api('GET', '/api/admin/logistics/loads'),
  ]);
  logisticsOrdersCache = orders;
  adminOrdersCache = orders; // pour que openOrderModal('admin') retrouve la commande

  const loadsByDriver = Object.fromEntries(loads.map(l => [String(l.driverId || ''), l]));
  const columns = [{ id: '', label: 'Non assigné' }, ...driversCache.map(d => ({ id: String(d.id), label: d.name }))];

  const kanban = document.getElementById('logistics-kanban');
  kanban.innerHTML = columns.map(col => {
    const list = orders.filter(o => String(o.driverId || '') === col.id);
    const load = loadsByDriver[col.id];
    const cartsLabel = load?.carts?.length
      ? load.carts.map(c => `${c.count} ${c.name}`).join(' + ')
      : 'aucun chariot nécessaire';
    const truckVolumeLine = load?.truckName ? `
        <div style="color:${load.overTruckVolume ? 'var(--rust)' : 'var(--steel-light)'};font-weight:${load.overTruckVolume ? '700' : '400'};">
          Véhicule : ${load.truckName} (${(load.truckVolumeL/1000).toFixed(2)} m³)${load.overTruckVolume ? ' ⚠️ volume dépassé' : ''}
        </div>` : '';
    const loadHtml = load && (load.totalWeightKg > 0 || load.totalVolumeL > 0) ? `
      <div style="background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:8px 10px;margin-bottom:10px;font-size:11.5px;">
        <div style="color:${load.overCapacity ? 'var(--rust)' : 'var(--steel)'};font-weight:${load.overCapacity ? '700' : '400'};">
          Poids total : ${load.totalWeightKg} kg / ${settings.truckCapacityKg} kg${load.overCapacity ? ' ⚠️ dépassement' : ''}
        </div>
        <div style="color:var(--steel-light);">(linge : ${load.linenWeightKg} kg + chariots : ${load.cartsWeightKg} kg)</div>
        <div style="color:var(--steel);margin-top:2px;">≈ ${cartsLabel} (${load.totalVolumeL} L au total)</div>
        ${truckVolumeLine}
      </div>
    ` : '';
    const readyCount = list.filter(o => o.status === 'prete').length;
    return `
      <div class="kcol driver-col" data-driver="${col.id}">
        <div class="kcol-head"><h4>${col.label}</h4><span class="kcol-count">${list.length}</span></div>
        ${loadHtml}
        ${readyCount > 0 ? `<button class="btn-secondary" data-optimize-route="${col.id}" style="width:auto;margin-bottom:10px;padding:6px 10px;font-size:11px;">📍 Optimiser la tournée</button>
        <div id="route-result-${col.id || 'none'}"></div>` : ''}
        <div class="kcol-drop">
        ${list.length === 0 ? '<div class="kcol-empty">Aucune commande</div>' : list.map(o => `
          <div class="mini-ticket ${o.status === 'prete' ? 'logistics-ready' : 'logistics-pending'}" data-id="${o.id}" draggable="true" tabindex="0" role="button" aria-label="Voir le détail de la commande ${o.ticket}, statut ${statusLabel(o.status)}">
            <div class="mini-num">${o.ticket}${o.status === 'prete' && o.deliverySequence ? ` <span class="mono" style="color:var(--brand-deep);">#${o.deliverySequence}</span>` : ''}</div>
            <div class="mini-client">${o.client.societe}</div>
            <div class="mini-sub">${o.client.adresse}</div>
            <div class="mini-sub" style="font-weight:600;color:${o.status === 'prete' ? 'var(--teal)' : 'var(--rust)'};">${o.status === 'prete' ? '✓ Prête à partir' : statusLabel(o.status)}</div>
          </div>
        `).join('')}
        </div>
      </div>
    `;
  }).join('');

  if (columns.length === 1) {
    kanban.innerHTML += '<p class="empty-note" style="grid-column:1/-1;">Ajoutez au moins un chauffeur ci-dessus pour pouvoir organiser les tournées.</p>';
  }

  kanban.querySelectorAll('[data-optimize-route]').forEach(btn => {
    btn.addEventListener('click', () => runRouteOptimization(btn.dataset.optimizeRoute || null));
  });

  kanban.querySelectorAll('.mini-ticket').forEach(el => {
    el.addEventListener('click', () => openOrderModal(el.dataset.id, 'logistics'));
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOrderModal(el.dataset.id, 'logistics'); } });
    el.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', el.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  });

  kanban.querySelectorAll('.kcol').forEach(col => {
    col.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', e => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
    });
    col.addEventListener('drop', async e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const orderId = e.dataTransfer.getData('text/plain');
      const newDriverId = col.dataset.driver ? Number(col.dataset.driver) : null;
      const order = logisticsOrdersCache.find(o => String(o.id) === String(orderId));
      if (!order || (order.driverId || null) === newDriverId) return;
      await api('PATCH', `/api/admin/logistics/orders/${orderId}`, { driverId: newDriverId, deliverySequence: null });
      renderLogisticsKanban();
    });
  });
}

// ---------- Statistiques (vue d'ensemble) ----------
async function askAiReport() {
  const input = document.getElementById('ai-report-question');
  const question = input.value.trim();
  if (!question) return;
  const btn = document.getElementById('btn-ask-ai-report');
  const zone = document.getElementById('ai-report-answer');
  btn.disabled = true;
  btn.textContent = 'Analyse en cours…';
  zone.innerHTML = '<p style="font-size:12.5px;color:var(--steel-light);">L\'agent interroge vos données…</p>';
  try {
    const { answer } = await api('POST', '/api/admin/stats/ai-report', { question });
    zone.innerHTML = `
      <div style="background:var(--bg);border-left:3px solid var(--brand);border-radius:5px;padding:12px 16px;">
        <div style="font-size:11px;color:var(--steel-light);margin-bottom:6px;">« ${escapeHtml(question)} »</div>
        <div style="font-size:13.5px;color:var(--ink);white-space:pre-wrap;line-height:1.5;">${escapeHtml(answer)}</div>
      </div>
    `;
  } catch (err) {
    zone.innerHTML = `<p style="font-size:12.5px;color:var(--rust);">${err.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Poser la question';
  }
}
document.getElementById('btn-ask-ai-report').addEventListener('click', askAiReport);
document.getElementById('ai-report-question').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); askAiReport(); }
});

async function renderStats() {
  const [stats, nps] = await Promise.all([
    api('GET', '/api/admin/stats'),
    api('GET', '/api/admin/stats/nps'),
  ]);
  const el = document.getElementById('stats-content');

  const maxHotel = Math.max(1, ...stats.topHotels.map(h => h.orderCount));
  const maxArticle = Math.max(1, ...stats.topArticles.map(a => a.totalQty));

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stats-card"><div class="eyebrow">Commandes totales</div><strong>${stats.totalOrders}</strong></div>
      <div class="stats-card"><div class="eyebrow">Articles traités</div><strong>${stats.totalItems}</strong></div>
      <div class="stats-card"><div class="eyebrow">Commandes (30 derniers jours)</div><strong>${stats.last30Days}</strong></div>
      <div class="stats-card"><div class="eyebrow">Hôtels actifs</div><strong>${stats.topHotels.length}</strong></div>
      <div class="stats-card"><div class="eyebrow">Poids livré (hors chariot)</div><strong>${stats.deliveredWeightKg} kg</strong></div>
      <div class="stats-card"><div class="eyebrow">Kilomètres parcourus</div><strong>${stats.totalDistanceKm} km</strong></div>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <h4 class="card-subhead" style="margin-bottom:4px;">Satisfaction client (NPS)</h4>
      <p style="font-size:12.5px;color:var(--steel);margin:0 0 14px;">Calculé à partir du questionnaire proposé aux hôtels dans « Mon espace », une fois par mois.</p>
      ${nps.currentMonth ? `
        <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap;margin-bottom:16px;">
          <div>
            <div style="font-family:'Fredoka',sans-serif;font-size:40px;font-weight:600;color:${nps.currentMonth.nps >= 0 ? 'var(--teal)' : 'var(--rust)'};line-height:1;">${nps.currentMonth.nps > 0 ? '+' : ''}${nps.currentMonth.nps}</div>
            <div style="font-size:11px;color:var(--steel-light);text-transform:uppercase;letter-spacing:0.04em;margin-top:4px;">NPS — ${nps.currentMonth.month}</div>
          </div>
          <div style="display:flex;gap:16px;font-size:12.5px;color:var(--steel);">
            <span>😍 Promoteurs : <b style="color:var(--ink);">${nps.currentMonth.promoters}</b></span>
            <span>😐 Passifs : <b style="color:var(--ink);">${nps.currentMonth.passives}</b></span>
            <span>😞 Détracteurs : <b style="color:var(--ink);">${nps.currentMonth.detractors}</b></span>
            <span>· ${nps.currentMonth.responses} réponse${nps.currentMonth.responses > 1 ? 's' : ''}</span>
          </div>
        </div>
      ` : '<p class="empty-note">Aucune réponse pour le moment ce mois-ci.</p>'}
      ${nps.months.length > 1 ? `
        <div style="border-top:1px solid var(--line);padding-top:12px;">
          <p style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--steel);margin:0 0 8px;">Historique</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${nps.months.slice(1).map(m => `<span class="mini-badge">${m.month} : ${m.nps > 0 ? '+' : ''}${m.nps} (${m.responses})</span>`).join('')}
          </div>
        </div>
      ` : ''}
      ${nps.recentComments.length > 0 ? `
        <div style="border-top:1px solid var(--line);padding-top:12px;margin-top:14px;">
          <p style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--steel);margin:0 0 8px;">Derniers commentaires</p>
          ${nps.recentComments.map(c => `
            <div style="padding:6px 0;border-bottom:1px solid var(--line);font-size:12.5px;">
              <span class="mini-badge" style="margin-right:6px;">${c.score}/10</span><b>${c.societe}</b> — ${c.comment}
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>

    <div class="card" style="margin-bottom:20px;">
      <h4 class="card-subhead" style="margin-bottom:12px;">Répartition par statut</h4>
      <div class="stats-status-breakdown">
        ${STATUSES.map(s => `<span class="stats-status-pill">${s.label} : <b>${stats.byStatus[s.id] || 0}</b></span>`).join('')}
      </div>
    </div>

    <div class="stats-lists">
      <div class="stats-list-card">
        <h5>Top hôtels (par nombre de commandes)</h5>
        ${stats.topHotels.length === 0 ? '<p class="empty-note">Pas encore de données.</p>' : stats.topHotels.map(h => `
          <div class="stats-row">
            <span>${h.societe}</span>
            <span class="stats-row-bar"><span class="stats-row-bar-fill" style="width:${(h.orderCount / maxHotel) * 100}%;"></span></span>
            <span class="mono">${h.orderCount}</span>
          </div>
        `).join('')}
      </div>
      <div class="stats-list-card">
        <h5>Articles les plus commandés</h5>
        ${stats.topArticles.length === 0 ? '<p class="empty-note">Pas encore de données.</p>' : stats.topArticles.map(a => `
          <div class="stats-row">
            <span>${a.name}</span>
            <span class="stats-row-bar"><span class="stats-row-bar-fill" style="width:${(a.totalQty / maxArticle) * 100}%;"></span></span>
            <span class="mono">${a.totalQty}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// ---------- Gestion des articles (catalogue + attribution par hôtel) ----------
let articlesCache = [];
let articleCategoriesCache = [];

async function renderArticlesView() {
  await ensureClientsCache();
  await renderArticlesList();
  await renderCartTypesList();
  await renderTruckTypesList();
  renderArticlesClientSelect();
}

let cartTypesCache = [];
async function ensureCartTypesCache() {
  const { cartTypes } = await api('GET', '/api/admin/articles/cart-types');
  cartTypesCache = cartTypes;
  return cartTypes;
}
async function renderCartTypesList() {
  const cartTypes = await ensureCartTypesCache();
  const el = document.getElementById('cart-types-list');
  if (cartTypes.length === 0) {
    el.innerHTML = '<p class="empty-note">Aucun chariot enregistré.</p>';
  } else {
    el.innerHTML = cartTypes.map(c => `
      <span class="driver-chip">
        ${c.name} — ${c.lengthCm}×${c.widthCm}×${c.heightCm} cm <span class="driver-vehicle">(${c.volumeL} L)</span>
        <button data-delete-cart="${c.id}" aria-label="Retirer ce chariot">✕</button>
      </span>
    `).join('');
    el.querySelectorAll('[data-delete-cart]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Retirer ce type de chariot ?')) return;
        await api('DELETE', `/api/admin/articles/cart-types/${btn.dataset.deleteCart}`);
        renderCartTypesList();
      });
    });
  }
}
document.getElementById('btn-add-cart-type').addEventListener('click', async () => {
  const name = document.getElementById('new-cart-name').value.trim();
  const lengthCm = document.getElementById('new-cart-length').value;
  const widthCm = document.getElementById('new-cart-width').value;
  const heightCm = document.getElementById('new-cart-height').value;
  if (!name || !lengthCm || !widthCm || !heightCm) return;
  await api('POST', '/api/admin/articles/cart-types', { name, lengthCm, widthCm, heightCm });
  document.getElementById('new-cart-name').value = '';
  document.getElementById('new-cart-length').value = '';
  document.getElementById('new-cart-width').value = '';
  document.getElementById('new-cart-height').value = '';
  renderCartTypesList();
});

let truckTypesCache = [];
async function renderTruckTypesList() {
  const { truckTypes } = await api('GET', '/api/admin/articles/truck-types');
  truckTypesCache = truckTypes;
  const el = document.getElementById('truck-types-list');
  if (truckTypes.length === 0) {
    el.innerHTML = '<p class="empty-note">Aucun véhicule enregistré.</p>';
  } else {
    el.innerHTML = truckTypes.map(t => `
      <span class="driver-chip">
        ${t.name} — ${t.lengthCm}×${t.widthCm}×${t.heightCm} cm <span class="driver-vehicle">(${(t.volumeL/1000).toFixed(2)} m³)</span>
        <button data-delete-truck="${t.id}" aria-label="Retirer ce véhicule">✕</button>
      </span>
    `).join('');
    el.querySelectorAll('[data-delete-truck]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Retirer ce type de camion ?')) return;
        await api('DELETE', `/api/admin/articles/truck-types/${btn.dataset.deleteTruck}`);
        renderTruckTypesList();
      });
    });
  }
  // Peuple aussi le sélecteur du formulaire de création de chauffeur (Logistique)
  const select = document.getElementById('new-driver-truck-type');
  if (select) {
    select.innerHTML = '<option value="">— Aucun —</option>' +
      truckTypes.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
  }
}
document.getElementById('btn-add-truck-type').addEventListener('click', async () => {
  const name = document.getElementById('new-truck-name').value.trim();
  const lengthCm = document.getElementById('new-truck-length').value;
  const widthCm = document.getElementById('new-truck-width').value;
  const heightCm = document.getElementById('new-truck-height').value;
  if (!name || !lengthCm || !widthCm || !heightCm) return;
  await api('POST', '/api/admin/articles/truck-types', { name, lengthCm, widthCm, heightCm });
  document.getElementById('new-truck-name').value = '';
  document.getElementById('new-truck-length').value = '';
  document.getElementById('new-truck-width').value = '';
  document.getElementById('new-truck-height').value = '';
  renderTruckTypesList();
});

async function renderArticlesList() {
  const { articles, categories } = await api('GET', '/api/admin/articles');
  articlesCache = articles;
  articleCategoriesCache = categories;
  const el = document.getElementById('articles-list');
  if (articles.length === 0) {
    el.innerHTML = '<p class="empty-note">Aucun article dans le catalogue.</p>';
    return;
  }
  el.innerHTML = articles.map(a => `
    <div class="room-type-card">
      <div class="room-type-card-head">
        <h5>${a.name} <span class="mini-badge" style="margin-left:6px;">${a.code}</span></h5>
        <div class="room-type-actions">
          <button data-edit-article="${a.id}">Modifier</button>
          <button class="danger" data-delete-article="${a.id}">Supprimer</button>
        </div>
      </div>
      <div class="room-type-summary">
        Sage : <b>${a.sageCode}</b> · Prix : <b>${a.price.toFixed(3)} €</b> · Poids : <b>${a.weightG} g</b> · Dimensions : <b>${a.widthCm}×${a.lengthCm} cm</b><br>
        Plié : <b>${a.foldedWidthCm}×${a.foldedLengthCm}×${a.foldedHeightCm} cm</b> · Volume de conditionnement : <b>${((a.foldedWidthCm * a.foldedLengthCm * a.foldedHeightCm) / 1000).toFixed(2)} L</b> <span style="color:var(--steel-light);">(utilisé pour le chargement en Logistique)</span>
      </div>
    </div>
  `).join('');
  el.querySelectorAll('[data-edit-article]').forEach(btn => {
    btn.addEventListener('click', () => renderArticleForm(articlesCache.find(a => a.id === btn.dataset.editArticle)));
  });
  el.querySelectorAll('[data-delete-article]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Supprimer cet article du catalogue ? Les commandes déjà passées ne sont pas affectées.')) return;
      await api('DELETE', `/api/admin/articles/${btn.dataset.deleteArticle}`);
      renderArticlesList();
    });
  });
}
document.getElementById('btn-add-article').addEventListener('click', () => renderArticleForm(null));

// Sections repliables — délégation d'événements sur tout le document,
// pour couvrir aussi bien les sections statiques (Gestion des articles)
// que celles générées dynamiquement (fiche client) sans avoir à
// re-câbler à chaque rendu. Il suffit d'ajouter, sur n'importe quel
// bouton : class="collapse-toggle" data-collapse-target="id-de-la-zone".
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.collapse-toggle');
  if (!btn) return;
  const target = document.getElementById(btn.dataset.collapseTarget);
  if (!target) return;
  const isCurrentlyHidden = target.style.display === 'none';
  target.style.display = isCurrentlyHidden ? '' : 'none';
  btn.classList.toggle('collapsed', !isCurrentlyHidden);
});

function renderArticleForm(existing) {
  const zone = document.getElementById('article-form-zone');
  zone.innerHTML = `
    <div class="card" style="margin-top:14px;background:var(--bg);">
      <h4 class="card-subhead">${existing ? 'Modifier' : 'Nouvel'} article</h4>
      <div class="field-row">
        <div class="field"><label>Nom</label><input id="art-name" value="${existing ? existing.name.replace(/"/g, '&quot;') : ''}" placeholder="Ex. Drap plat 2 pers."></div>
        <div class="field"><label>Code (badge affiché)</label><input id="art-code" value="${existing ? existing.code : ''}" placeholder="Ex. DP2"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Code Sage complet</label><input id="art-sagecode" value="${existing ? existing.sageCode : ''}" placeholder="Ex. B-DP2"></div>
        <div class="field">
          <label>Catégorie</label>
          <select id="art-category">
            ${articleCategoriesCache.map(c => `<option value="${c.id}" ${existing?.category === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label>Prix (€)</label><input type="number" step="0.001" min="0" id="art-price" value="${existing ? existing.price : ''}"></div>
        <div class="field"><label>Poids unitaire (g)</label><input type="number" step="1" min="0" id="art-weight" value="${existing ? existing.weightG : ''}"></div>
        <div class="field"><label>Volume unitaire (L) — non utilisé pour la logistique</label><input type="number" step="0.1" min="0" id="art-volume" value="${existing ? existing.volumeL : ''}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Largeur (cm)</label><input type="number" step="1" min="0" id="art-width" value="${existing ? existing.widthCm : ''}"></div>
        <div class="field"><label>Longueur (cm)</label><input type="number" step="1" min="0" id="art-length" value="${existing ? existing.lengthCm : ''}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Largeur pliée (cm)</label><input type="number" step="1" min="0" id="art-folded-width" value="${existing ? existing.foldedWidthCm : ''}"></div>
        <div class="field"><label>Longueur pliée (cm)</label><input type="number" step="1" min="0" id="art-folded-length" value="${existing ? existing.foldedLengthCm : ''}"></div>
        <div class="field"><label>Épaisseur pliée (cm)</label><input type="number" step="0.5" min="0" id="art-folded-height" value="${existing ? existing.foldedHeightCm : ''}"></div>
      </div>
      <button class="btn-primary" id="art-save" style="width:auto;margin-top:8px;">Enregistrer</button>
      <button class="btn-secondary" id="art-cancel" style="width:auto;">Annuler</button>
      <div class="qty-save-note" id="art-error"></div>
    </div>
  `;
  document.getElementById('art-cancel').addEventListener('click', () => { zone.innerHTML = ''; });
  document.getElementById('art-save').addEventListener('click', () => saveArticle(existing?.id));
  zone.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveArticle(existingId) {
  const errorNote = document.getElementById('art-error');
  const payload = {
    name: document.getElementById('art-name').value.trim(),
    code: document.getElementById('art-code').value.trim(),
    sageCode: document.getElementById('art-sagecode').value.trim(),
    category: document.getElementById('art-category').value,
    price: document.getElementById('art-price').value,
    weightG: document.getElementById('art-weight').value,
    volumeL: document.getElementById('art-volume').value,
    widthCm: document.getElementById('art-width').value,
    lengthCm: document.getElementById('art-length').value,
    foldedWidthCm: document.getElementById('art-folded-width').value,
    foldedLengthCm: document.getElementById('art-folded-length').value,
    foldedHeightCm: document.getElementById('art-folded-height').value,
  };
  try {
    if (existingId) await api('PUT', `/api/admin/articles/${existingId}`, payload);
    else await api('POST', '/api/admin/articles', payload);
    document.getElementById('article-form-zone').innerHTML = '';
    renderArticlesList();
  } catch (err) {
    errorNote.textContent = err.message;
    errorNote.classList.add('error');
  }
}

function renderArticlesClientSelect() {
  const select = document.getElementById('articles-client-select');
  select.innerHTML = '<option value="">— Choisir un hôtel —</option>' +
    manualOrderClientsCache.map(c => `<option value="${c.id}">${c.societe}</option>`).join('');
  select.onchange = () => renderArticlesClientAssignment(select.value);
}

async function ensureClientsCache() {
  if (manualOrderClientsCache.length === 0) {
    const { clients } = await api('GET', '/api/admin/clients');
    manualOrderClientsCache = clients;
  }
}

async function renderArticlesClientAssignment(clientId) {
  const zone = document.getElementById('articles-client-assignment');
  if (!clientId) { zone.innerHTML = ''; return; }
  zone.innerHTML = '<p style="font-size:12.5px;color:var(--steel-light);">Chargement…</p>';

  const { articleIds } = await api('GET', `/api/admin/articles/client/${clientId}`);
  const selected = new Set(articleIds);

  zone.innerHTML = `
    ${articleIds.length === 0 ? '<p class="empty-note" style="margin-bottom:10px;">Aucune restriction — cet hôtel voit tout le catalogue.</p>' : ''}
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">
      ${articlesCache.map(a => `
        <label class="driver-chip" style="cursor:pointer;">
          <input type="checkbox" value="${a.id}" ${selected.has(a.id) ? 'checked' : ''} style="margin-right:4px;">
          ${a.code} — ${a.name}
        </label>
      `).join('')}
    </div>
    <button class="btn-secondary" id="btn-save-article-assignment" style="width:auto;">Enregistrer</button>
    <div class="qty-save-note" id="article-assignment-note"></div>
  `;
  document.getElementById('btn-save-article-assignment').addEventListener('click', async () => {
    const ids = [...zone.querySelectorAll('input:checked')].map(i => i.value);
    const note = document.getElementById('article-assignment-note');
    try {
      await api('PUT', `/api/admin/articles/client/${clientId}`, { articleIds: ids });
      note.style.color = 'var(--teal)';
      note.textContent = 'Enregistré ✓';
    } catch (err) {
      note.classList.add('error');
      note.textContent = err.message;
    }
  });
}

// ---------- Gestion des clients (hôtels) ----------
async function renderClientsView() {
  const { clients } = await api('GET', '/api/admin/clients');
  manualOrderClientsCache = clients; // même cache que celui utilisé ailleurs (commande manuelle, attribution articles...)
  const el = document.getElementById('clients-list');
  if (clients.length === 0) {
    el.innerHTML = '<p class="empty-note">Aucun hôtel enregistré pour le moment.</p>';
    return;
  }
  el.innerHTML = clients.map(c => `
    <div class="room-type-card">
      <div class="room-type-card-head">
        <h5>${c.societe}</h5>
        <div class="room-type-actions">
          <button data-edit-client="${c.id}">Modifier</button>
          <button class="danger" data-delete-client="${c.id}">Supprimer</button>
        </div>
      </div>
      <div class="room-type-summary">
        Contact : <b>${c.contact}</b> · Tél : <b>${c.tel}</b> · Email : <b>${c.email}</b><br>
        Adresse : <b>${c.adresse}</b>
      </div>
    </div>
  `).join('');
  el.querySelectorAll('[data-edit-client]').forEach(btn => {
    btn.addEventListener('click', () => renderClientForm(clients.find(c => String(c.id) === btn.dataset.editClient)));
  });
  el.querySelectorAll('[data-delete-client]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm("Supprimer cet hôtel ? Il perdra l'accès à son espace personnel. Ses commandes déjà passées restent conservées.")) return;
      await api('DELETE', `/api/admin/clients/${btn.dataset.deleteClient}`);
      renderClientsView();
    });
  });
}
document.getElementById('btn-add-client').addEventListener('click', () => renderClientForm(null));

function renderClientForm(existing) {
  const zone = document.getElementById('client-form-zone');
  zone.innerHTML = `
    <div class="card" style="margin-top:14px;margin-bottom:14px;background:var(--bg);">
      <h4 class="card-subhead">${existing ? 'Modifier' : 'Nouvel'} hôtel</h4>
      <div class="field-row">
        <div class="field"><label>Société / établissement</label><input id="cl-societe" value="${existing ? existing.societe.replace(/"/g, '&quot;') : ''}" placeholder="Ex. Hôtel Verlaine"></div>
        <div class="field"><label>Nom du contact</label><input id="cl-contact" value="${existing ? existing.contact.replace(/"/g, '&quot;') : ''}" placeholder="Ex. Camille Roux"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Téléphone</label><input id="cl-tel" value="${existing ? existing.tel : ''}" placeholder="06 12 34 56 78"></div>
        <div class="field"><label>Email</label><input id="cl-email" type="email" value="${existing ? existing.email : ''}" placeholder="vous@societe.fr"></div>
      </div>
      <div class="field"><label>Adresse</label><input id="cl-adresse" value="${existing ? existing.adresse.replace(/"/g, '&quot;') : ''}" placeholder="Ex. 12 rue de la Paix, 84200 Carpentras"></div>
      <p style="font-size:11px;color:var(--steel-light);margin:-6px 0 0;">Le code postal est important pour que la localisation des tournées fonctionne correctement.</p>
      ${existing ? `
        <div class="field-row" style="margin-top:10px;">
          <div class="field"><label>SIRET</label><input id="cl-siret" value="${existing.siret || ''}" inputmode="numeric" maxlength="14" placeholder="14 chiffres"></div>
          <div class="field"><label>N° TVA intracommunautaire</label><input id="cl-tva" value="${existing.tvaNumber || ''}" placeholder="Ex. FR12345678901"></div>
        </div>
        <div class="field"><label>Adresse de facturation (si différente)</label><input id="cl-adresse-facturation" value="${(existing.adresseFacturation || '').replace(/"/g, '&quot;')}" placeholder="Laisser vide pour utiliser l'adresse ci-dessus"></div>
        <p style="font-size:11px;color:var(--steel-light);margin:-6px 0 0;">Ces informations peuvent aussi être renseignées par l'hôtel lui-même depuis son espace.</p>
      ` : ''}
      <div class="field" style="max-width:260px;">
        <label>${existing ? "Nouveau code d'accès (optionnel)" : "Code d'accès"}</label>
        <input id="cl-code" inputmode="numeric" maxlength="8" placeholder="${existing ? 'Laisser vide = inchangé' : '4 à 8 chiffres'}">
      </div>
      ${existing ? '<p style="font-size:11px;color:var(--steel-light);margin:4px 0 0;">Le code actuel n\'est jamais visible (il est chiffré) — n\'en saisissez un nouveau que si l\'hôtel l\'a oublié.</p>' : ''}
      <button class="btn-primary" id="cl-save" style="width:auto;margin-top:12px;">Enregistrer</button>
      <button class="btn-secondary" id="cl-cancel" style="width:auto;">Annuler</button>
      <div class="qty-save-note" id="cl-error"></div>
      ${existing ? `

        <div style="border-top:1px solid var(--line);margin-top:16px;padding-top:14px;">
          <div class="collapsible-head"><h4 class="card-subhead" style="margin-bottom:4px;">Tarifs & catalogue accessible</h4><button class="collapse-toggle" data-collapse-target="section-prices-${existing.id}">▾</button></div>
          <div id="section-prices-${existing.id}">
            <p style="font-size:11.5px;color:var(--steel);margin:0 0 10px;">Prix catalogue pré-rempli pour chaque article — ne modifiez que ceux qui sont réellement négociés. La case à cocher détermine si l'hôtel peut commander cet article du tout.</p>
            <div id="attribution-status-${existing.id}" style="font-size:11px;color:var(--steel);background:var(--bg);padding:6px 10px;border-radius:4px;margin-bottom:10px;"></div>
            <div class="field-row" style="align-items:end;margin-bottom:10px;">
              <div class="field"><label>Dupliquer les tarifs d'un autre hôtel</label>
                <select id="dup-source-client-${existing.id}"><option value="">— Choisir un hôtel —</option></select>
              </div>
              <button class="btn-secondary" id="btn-duplicate-prices-${existing.id}" style="width:auto;">Dupliquer</button>
            </div>
            <div id="client-prices-list-${existing.id}"><p class="empty-note">Chargement…</p></div>
            <div class="qty-save-note" id="prices-note-${existing.id}"></div>
          </div>
        </div>

        <div style="border-top:1px solid var(--line);margin-top:16px;padding-top:14px;">
          <div class="collapsible-head"><h4 class="card-subhead" style="margin-bottom:4px;">Intégration API</h4><button class="collapse-toggle" data-collapse-target="section-apitoken-${existing.id}">▾</button></div>
          <div id="section-apitoken-${existing.id}">
            <p style="font-size:11.5px;color:var(--steel);margin:0 0 10px;">Pour qu'un logiciel de commande utilisé par cet hôtel crée ses commandes automatiquement. Voir la documentation fournie pour le détail des appels.</p>
            <div id="api-tokens-list-${existing.id}"></div>
            <div class="field-row" style="margin-top:8px;align-items:end;">
              <div class="field"><label>Libellé (optionnel)</label><input id="new-token-label-${existing.id}" placeholder="Ex. Logiciel de commande interne"></div>
              <button class="btn-secondary" id="btn-create-token-${existing.id}" style="width:auto;">+ Générer un jeton</button>
            </div>
          </div>
        </div>

        <div style="border-top:1px solid var(--line);margin-top:16px;padding-top:14px;">
          <div class="collapsible-head"><h4 class="card-subhead" style="margin-bottom:4px;">Webhook — notification de livraison</h4><button class="collapse-toggle" data-collapse-target="section-webhook-${existing.id}">▾</button></div>
          <div id="section-webhook-${existing.id}">
            <p style="font-size:11.5px;color:var(--steel);margin:0 0 10px;">URL du logiciel de cet hôtel à notifier automatiquement (quantités définitives) dès qu'une de ses commandes passe au statut « Livrée ».</p>
            <div class="field"><label>URL du webhook</label><input id="webhook-url-${existing.id}" placeholder="https://logiciel-client.example.com/webhook"></div>
            <button class="btn-secondary" id="btn-save-webhook-${existing.id}" style="width:auto;margin-top:6px;">Enregistrer</button>
            <div id="webhook-secret-zone-${existing.id}" style="margin-top:8px;"></div>
            <div class="qty-save-note" id="webhook-note-${existing.id}"></div>
          </div>
        </div>
      ` : ''}
    </div>
  `;
  document.getElementById('cl-cancel').addEventListener('click', () => { zone.innerHTML = ''; });
  document.getElementById('cl-save').addEventListener('click', () => saveClient(existing?.id));
  if (existing) {
    renderClientPricesList(existing.id);
    const dupSelect = document.getElementById(`dup-source-client-${existing.id}`);
    dupSelect.innerHTML = '<option value="">— Choisir un hôtel —</option>' +
      manualOrderClientsCache.filter(c => c.id !== existing.id).map(c => `<option value="${c.id}">${c.societe}</option>`).join('');
    document.getElementById(`btn-duplicate-prices-${existing.id}`).addEventListener('click', async () => {
      const sourceClientId = dupSelect.value;
      const note = document.getElementById(`prices-note-${existing.id}`);
      if (!sourceClientId) { note.classList.add('error'); note.textContent = 'Choisissez un hôtel source.'; return; }
      try {
        const { count } = await api('POST', `/api/admin/clients/${existing.id}/prices/duplicate-from`, { sourceClientId });
        note.classList.remove('error');
        note.style.color = 'var(--teal)';
        note.textContent = `${count} tarif(s) dupliqué(s) ✓`;
        renderClientPricesList(existing.id);
      } catch (err) {
        note.classList.add('error');
        note.textContent = err.message;
      }
    });

    renderApiTokensList(existing.id);
    document.getElementById(`btn-create-token-${existing.id}`).addEventListener('click', async () => {
      const label = document.getElementById(`new-token-label-${existing.id}`).value.trim();
      await api('POST', `/api/admin/clients/${existing.id}/api-tokens`, { label });
      document.getElementById(`new-token-label-${existing.id}`).value = '';
      renderApiTokensList(existing.id);
    });
    renderWebhookConfig(existing.id);
    document.getElementById(`btn-save-webhook-${existing.id}`).addEventListener('click', async () => {
      const note = document.getElementById(`webhook-note-${existing.id}`);
      try {
        await api('PUT', `/api/admin/clients/${existing.id}/webhook`, {
          webhookUrl: document.getElementById(`webhook-url-${existing.id}`).value.trim(),
        });
        note.classList.remove('error');
        note.style.color = 'var(--teal)';
        note.textContent = 'Enregistré ✓';
        renderWebhookConfig(existing.id);
      } catch (err) {
        note.classList.add('error');
        note.textContent = err.message;
      }
    });
  }
  zone.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- onglet Facture (centralise tous les sujets Odoo/facturation) ----------
let factureClientsCache = [];
let currentFactureClientId = null;

async function renderFactureTab() {
  const { odooTaxId } = await api('GET', '/api/admin/odoo/settings');
  loadOdooTaxesIntoSelect(odooTaxId);

  const select = document.getElementById('facture-client-select');
  if (factureClientsCache.length === 0) {
    const { clients } = await api('GET', '/api/admin/clients');
    factureClientsCache = clients;
    select.innerHTML = '<option value="">— Choisir un hôtel —</option>' +
      clients.map(c => `<option value="${c.id}">${c.societe}</option>`).join('');
  }
}

async function loadFactureClientContent(clientId) {
  currentFactureClientId = clientId;
  const content = document.getElementById('facture-client-content');
  if (!clientId) { content.style.display = 'none'; return; }
  content.style.display = 'block';

  const client = factureClientsCache.find(c => String(c.id) === String(clientId));
  document.getElementById('facture-odoo-status').textContent = client?.odooPartnerId
    ? `✓ Synchronisé (id Odoo ${client.odooPartnerId})` : 'Pas encore synchronisé';
  document.getElementById('facture-detail-level').value = client?.invoiceDetailLevel || 'detail';
  document.getElementById('facture-odoo-note').textContent = '';
  document.getElementById('facture-detail-level-note').textContent = '';

  renderInvoiceableOrders(clientId);
  renderPastInvoices(clientId);
}

document.getElementById('facture-client-select').addEventListener('change', (e) => {
  loadFactureClientContent(e.target.value);
});

document.getElementById('btn-facture-odoo-sync').addEventListener('click', async (e) => {
  if (!currentFactureClientId) return;
  const btn = e.currentTarget;
  const note = document.getElementById('facture-odoo-note');
  btn.disabled = true;
  btn.textContent = 'Synchronisation…';
  try {
    const { odooPartnerId } = await api('POST', `/api/admin/clients/${currentFactureClientId}/odoo-sync`, {});
    document.getElementById('facture-odoo-status').textContent = `✓ Synchronisé (id Odoo ${odooPartnerId})`;
    note.classList.remove('error');
    note.style.color = 'var(--teal)';
    note.textContent = 'Synchronisation réussie ✓';
  } catch (err) {
    note.classList.add('error');
    note.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Synchroniser vers Odoo';
  }
});

document.getElementById('btn-facture-save-detail-level').addEventListener('click', async () => {
  if (!currentFactureClientId) return;
  const note = document.getElementById('facture-detail-level-note');
  const level = document.getElementById('facture-detail-level').value;
  try {
    await api('PUT', `/api/admin/clients/${currentFactureClientId}/invoice-detail-level`, { level });
    note.classList.remove('error');
    note.style.color = 'var(--teal)';
    note.textContent = 'Enregistré ✓';
    note.classList.add('show');
    setTimeout(() => note.classList.remove('show'), 2500);
  } catch (err) {
    note.classList.add('error');
    note.textContent = err.message;
  }
});

async function renderInvoiceableOrders(clientId) {
  const zone = document.getElementById('invoiceable-orders-facture');
  const genBtn = document.getElementById('btn-generate-invoice-facture');
  const { orders } = await api('GET', `/api/admin/clients/${clientId}/invoiceable-orders`);

  if (orders.length === 0) {
    zone.innerHTML = '<p class="empty-note">Aucun BL livré en attente de facturation pour cet hôtel.</p>';
    genBtn.disabled = true;
    return;
  }

  zone.innerHTML = `
    <p style="font-size:11px;color:var(--steel-light);margin:0 0 6px;">${orders.length} BL livré(s), pas encore facturé(s) :</p>
    ${orders.map(o => `
      <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;padding:3px 0;cursor:pointer;">
        <input type="checkbox" class="invoice-order-check" value="${o.id}" checked>
        ${o.ticket} — livré le ${o.livraisonPrevue ? new Date(o.livraisonPrevue).toLocaleDateString('fr-FR') : 'date inconnue'}
      </label>
    `).join('')}
  `;
  const updateBtnState = () => {
    genBtn.disabled = zone.querySelectorAll('.invoice-order-check:checked').length === 0;
  };
  zone.querySelectorAll('.invoice-order-check').forEach(cb => cb.addEventListener('change', updateBtnState));
  updateBtnState();

  genBtn.onclick = async () => {
    const orderIds = [...zone.querySelectorAll('.invoice-order-check:checked')].map(i => i.value);
    const note = document.getElementById('invoice-note-facture');
    genBtn.disabled = true;
    genBtn.textContent = 'Génération…';
    try {
      const result = await api('POST', `/api/admin/clients/${clientId}/invoices`, { orderIds });
      note.classList.remove('error');
      note.style.color = 'var(--teal)';
      note.textContent = `✓ Facture brouillon créée dans Odoo (${result.odooNumber || '#' + result.odooMoveId}) — ${result.totalHt?.toFixed(2)} € HT sur ${result.ordersCount} BL. À relire et valider dans Odoo.`;
      renderInvoiceableOrders(clientId);
      renderPastInvoices(clientId);
    } catch (err) {
      note.classList.add('error');
      note.textContent = err.message;
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = 'Générer la facture';
    }
  };
}

async function renderPastInvoices(clientId) {
  const zone = document.getElementById('past-invoices-facture');
  const { invoices } = await api('GET', `/api/admin/clients/${clientId}/invoices`);
  if (invoices.length === 0) { zone.innerHTML = ''; return; }
  zone.innerHTML = `
    <p style="font-size:11px;color:var(--steel-light);margin:0 0 6px;">Factures déjà générées :</p>
    ${invoices.map(inv => `
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:${inv.status === 'cancelled' ? 'var(--steel-light)' : 'var(--steel)'};padding:4px 0;border-bottom:1px solid var(--line);${inv.status === 'cancelled' ? 'text-decoration:line-through;' : ''}">
        <span>${inv.odooNumber || '#' + inv.odooMoveId} — ${inv.totalHt?.toFixed(2)} € HT — ${new Date(inv.periodStart).toLocaleDateString('fr-FR')} au ${new Date(inv.periodEnd).toLocaleDateString('fr-FR')}
          ${inv.status === 'cancelled' ? '<span class="mini-badge" style="text-decoration:none;margin-left:6px;background:var(--rust);color:#fff;">Annulée — BL libérés</span>' : ''}
        </span>
        <span style="display:flex;gap:8px;align-items:center;text-decoration:none;">
          ${inv.status !== 'cancelled' ? `<button data-sync-status="${inv.id}" style="background:none;border:1px solid var(--line);border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px;white-space:nowrap;">Vérifier le statut</button>` : ''}
          ${inv.pdfPath && inv.status !== 'cancelled'
            ? `<a href="/api/admin/invoices/${inv.id}/pdf" target="_blank" style="color:var(--brand);text-decoration:underline;font-size:11px;white-space:nowrap;">Télécharger le PDF</a>`
            : (inv.status !== 'cancelled' ? `<button data-retrieve-pdf="${inv.id}" style="background:none;border:1px solid var(--line);border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px;white-space:nowrap;">Récupérer le PDF</button>` : '')
          }
        </span>
      </div>
    `).join('')}
  `;
  zone.querySelectorAll('[data-sync-status]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Vérification…';
      try {
        const { odooState, released } = await api('POST', `/api/admin/invoices/${btn.dataset.syncStatus}/sync-status`, {});
        if (released) {
          alert(`Facture annulée dans Odoo (statut "${odooState}") — les BL rattachés sont de nouveau facturables.`);
        } else {
          alert(`Statut dans Odoo : "${odooState}" — rien à changer.`);
        }
        renderPastInvoices(clientId);
        renderInvoiceableOrders(clientId);
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });
  zone.querySelectorAll('[data-retrieve-pdf]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Récupération…';
      try {
        await api('POST', `/api/admin/invoices/${btn.dataset.retrievePdf}/retrieve-pdf`, {});
        renderPastInvoices(clientId);
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });
}

async function renderWebhookConfig(clientId) {
  const { webhookUrl, webhookSecret } = await api('GET', `/api/admin/clients/${clientId}/webhook`);
  document.getElementById(`webhook-url-${clientId}`).value = webhookUrl || '';
  const secretZone = document.getElementById(`webhook-secret-zone-${clientId}`);
  secretZone.innerHTML = webhookSecret ? `
    <p style="font-size:11px;color:var(--steel);margin:0;">
      Secret envoyé en en-tête <span class="mono">X-Cezanne-Webhook-Secret</span> de chaque appel, pour que le logiciel du client puisse vérifier son origine :
      <span class="mono" style="background:var(--bg);padding:2px 5px;border-radius:3px;word-break:break-all;">${webhookSecret}</span>
    </p>
  ` : '';
}

async function renderClientPricesList(clientId) {
  const el = document.getElementById(`client-prices-list-${clientId}`);
  const statusEl = document.getElementById(`attribution-status-${clientId}`);
  const { articles, hasRestriction } = await api('GET', `/api/admin/clients/${clientId}/prices`);

  statusEl.textContent = hasRestriction
    ? '🔒 Catalogue restreint — seuls les articles cochés sont accessibles à cet hôtel.'
    : '🔓 Aucune restriction — tout le catalogue est accessible (cocher un article démarre une restriction).';

  el.innerHTML = articles.map(a => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--line);font-size:12.5px;${a.isAttributed ? '' : 'opacity:0.5;'}" id="price-row-${clientId}-${a.id}">
      <div>
        <label style="cursor:pointer;">
          <input type="checkbox" data-toggle-attribution="${a.id}" ${a.isAttributed ? 'checked' : ''} style="margin-right:6px;vertical-align:middle;">
          <span>${a.name}</span>
        </label>
        <span style="color:var(--steel-light);"> — catalogue : ${a.catalogPrice.toFixed(3)} €</span>
        ${a.negotiatedPrice !== null ? `<span class="mini-badge" style="margin-left:6px;background:var(--teal);color:#fff;">négocié : ${a.negotiatedPrice.toFixed(3)} € depuis ${new Date(a.negotiatedSince).toLocaleDateString('fr-FR')}</span>` : ''}
      </div>
      <div style="display:flex;gap:6px;">
        <button data-edit-price="${a.id}" style="background:none;border:1px solid var(--line);border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px;">Modifier</button>
        ${a.negotiatedPrice !== null ? `<button data-reset-price="${a.id}" style="background:none;border:none;color:var(--rust);cursor:pointer;font-size:11px;">Retirer</button>` : ''}
      </div>
    </div>
    <div id="price-edit-${clientId}-${a.id}"></div>
  `).join('');

  el.querySelectorAll('[data-toggle-attribution]').forEach(cb => {
    cb.addEventListener('click', async (e) => {
      e.stopPropagation();
      const articleId = cb.dataset.toggleAttribution;
      try {
        await api('PUT', `/api/admin/clients/${clientId}/articles/${articleId}/attribution`, { attributed: cb.checked });
        renderClientPricesList(clientId);
      } catch (err) {
        cb.checked = !cb.checked; // annule visuellement si l'appel échoue
        alert(err.message);
      }
    });
  });

  el.querySelectorAll('[data-edit-price]').forEach(btn => {
    btn.addEventListener('click', () => {
      const articleId = btn.dataset.editPrice;
      const article = articles.find(a => a.id === articleId);
      const editZone = document.getElementById(`price-edit-${clientId}-${articleId}`);
      if (editZone.dataset.open === 'true') { editZone.innerHTML = ''; editZone.dataset.open = 'false'; return; }
      editZone.dataset.open = 'true';
      editZone.innerHTML = `
        <div class="field-row" style="align-items:end;background:var(--bg);padding:8px;border-radius:5px;margin:4px 0 10px;">
          <div class="field"><label>Nouveau prix (€)</label><input type="number" step="0.001" min="0" id="price-input-${clientId}-${articleId}" value="${article.negotiatedPrice ?? article.catalogPrice}"></div>
          <div class="field"><label>Effectif à partir du</label><input type="date" id="price-date-${clientId}-${articleId}" value="${new Date().toISOString().slice(0, 10)}"></div>
          <button class="btn-secondary" data-start-of-month="${articleId}" style="width:auto;padding:6px 8px;font-size:11px;" title="Positionner au 1er du mois en cours">1er du mois</button>
          <button class="btn-secondary" data-confirm-price="${articleId}" style="width:auto;">Enregistrer</button>
        </div>
      `;
      document.getElementById(`price-edit-${clientId}-${articleId}`).querySelector('[data-start-of-month]').addEventListener('click', () => {
        const now = new Date();
        const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        document.getElementById(`price-date-${clientId}-${articleId}`).value = firstOfMonth;
      });
      document.getElementById(`price-edit-${clientId}-${articleId}`).querySelector('[data-confirm-price]').addEventListener('click', async () => {
        const note = document.getElementById(`prices-note-${clientId}`);
        try {
          await api('PUT', `/api/admin/clients/${clientId}/prices/${articleId}`, {
            price: document.getElementById(`price-input-${clientId}-${articleId}`).value,
            dateDebut: document.getElementById(`price-date-${clientId}-${articleId}`).value,
          });
          note.classList.remove('error');
          note.style.color = 'var(--teal)';
          note.textContent = 'Tarif enregistré ✓';
          renderClientPricesList(clientId);
        } catch (err) {
          note.classList.add('error');
          note.textContent = err.message;
        }
      });
    });
  });

  el.querySelectorAll('[data-reset-price]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Retirer ce tarif négocié ? Le prix catalogue s\'appliquera à nouveau dès aujourd\'hui.')) return;
      await api('DELETE', `/api/admin/clients/${clientId}/prices/${btn.dataset.resetPrice}`);
      renderClientPricesList(clientId);
    });
  });
}

async function renderApiTokensList(clientId) {
  const el = document.getElementById(`api-tokens-list-${clientId}`);
  const { tokens } = await api('GET', `/api/admin/clients/${clientId}/api-tokens`);
  if (tokens.length === 0) {
    el.innerHTML = '<p class="empty-note">Aucun jeton généré pour cet hôtel.</p>';
    return;
  }
  el.innerHTML = tokens.map(t => `
    <div style="background:var(--paper);border:1px solid var(--line);border-radius:5px;padding:8px 10px;margin-bottom:6px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <div style="font-size:12px;color:var(--ink);font-weight:600;">${t.label || '(sans libellé)'}</div>
        <button data-revoke-token="${t.id}" style="background:none;border:none;color:var(--rust);cursor:pointer;font-size:11px;">Révoquer</button>
      </div>
      <div class="mono" style="font-size:11px;color:var(--steel);word-break:break-all;margin-top:4px;background:var(--bg);padding:4px 6px;border-radius:3px;">${t.token}</div>
      <div style="font-size:10.5px;color:var(--steel-light);margin-top:3px;">
        Créé le ${new Date(t.createdAt).toLocaleDateString('fr-FR')}${t.lastUsedAt ? ` · dernier appel le ${new Date(t.lastUsedAt).toLocaleDateString('fr-FR')}` : ' · jamais utilisé'}
      </div>
    </div>
  `).join('');
  el.querySelectorAll('[data-revoke-token]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Révoquer ce jeton ? Toute intégration qui l\'utilise cessera immédiatement de fonctionner.')) return;
      await api('DELETE', `/api/admin/api-tokens/${btn.dataset.revokeToken}`);
      renderApiTokensList(clientId);
    });
  });
}

async function saveClient(existingId) {
  const errorNote = document.getElementById('cl-error');
  const payload = {
    societe: document.getElementById('cl-societe').value.trim(),
    contact: document.getElementById('cl-contact').value.trim(),
    tel: document.getElementById('cl-tel').value.trim(),
    adresse: document.getElementById('cl-adresse').value.trim(),
    email: document.getElementById('cl-email').value.trim(),
  };
  const code = document.getElementById('cl-code').value.trim();
  if (code) payload.code = code;
  if (existingId) {
    payload.siret = document.getElementById('cl-siret').value.trim();
    payload.tvaNumber = document.getElementById('cl-tva').value.trim();
    payload.adresseFacturation = document.getElementById('cl-adresse-facturation').value.trim();
  }
  if (!existingId && !code) {
    errorNote.textContent = "Le code d'accès est requis pour un nouvel hôtel.";
    errorNote.classList.add('error');
    return;
  }
  try {
    if (existingId) await api('PUT', `/api/admin/clients/${existingId}`, payload);
    else await api('POST', '/api/admin/clients', payload);
    document.getElementById('client-form-zone').innerHTML = '';
    renderClientsView();
  } catch (err) {
    errorNote.textContent = err.message;
    errorNote.classList.add('error');
  }
}

// ---------- Garage (kilométrage + entretien véhicules) ----------
async function renderGarageView() {
  const { trucks } = await api('GET', '/api/admin/garage/trucks');
  const zone = document.getElementById('garage-trucks-list');

  if (trucks.length === 0) {
    zone.innerHTML = '<p class="empty-note">Aucun véhicule enregistré — ajoutez-en un dans Gestion des articles → Types de camions.</p>';
    return;
  }

  zone.innerHTML = trucks.map(t => `
    <div class="card" style="margin-bottom:20px;">
      <h4 class="card-subhead">${t.name}</h4>
      <div class="settings-row" style="margin-bottom:16px;">
        <div class="field">
          <label>Kilométrage actuel (km)</label>
          <input type="number" min="0" id="mileage-${t.id}" value="${t.currentMileageKm ?? ''}" placeholder="Relevé au compteur">
        </div>
        <button class="btn-secondary" data-save-mileage="${t.id}">Enregistrer</button>
      </div>
      <div class="qty-save-note" id="mileage-note-${t.id}"></div>

      <h4 class="card-subhead" style="margin-top:18px;">Historique d'entretien</h4>
      <div id="maintenance-list-${t.id}"><p class="empty-note">Chargement…</p></div>

      <div class="field-row" style="margin-top:12px;align-items:end;">
        <div class="field"><label>Date</label><input type="date" id="maint-date-${t.id}"></div>
        <div class="field"><label>Type</label><input id="maint-type-${t.id}" placeholder="Ex. Vidange, Contrôle technique"></div>
        <div class="field"><label>Km au relevé</label><input type="number" min="0" id="maint-km-${t.id}"></div>
        <div class="field"><label>Coût (€)</label><input type="number" min="0" step="0.01" id="maint-cost-${t.id}"></div>
      </div>
      <div class="field"><label>Notes (optionnel)</label><input id="maint-notes-${t.id}" placeholder="Ex. Garage Dupont, pneus avant remplacés"></div>
      <button class="btn-secondary" data-add-maintenance="${t.id}" style="margin-top:8px;">+ Ajouter cet entretien</button>
      <div class="qty-save-note" id="maint-note-${t.id}"></div>
    </div>
  `).join('');

  trucks.forEach(t => renderMaintenanceList(t.id));

  zone.querySelectorAll('[data-save-mileage]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const truckId = btn.dataset.saveMileage;
      const note = document.getElementById(`mileage-note-${truckId}`);
      try {
        await api('PUT', `/api/admin/garage/trucks/${truckId}/mileage`, { mileageKm: document.getElementById(`mileage-${truckId}`).value });
        note.classList.remove('error');
        note.style.color = 'var(--teal)';
        note.textContent = 'Enregistré ✓';
      } catch (err) {
        note.classList.add('error');
        note.textContent = err.message;
      }
    });
  });

  zone.querySelectorAll('[data-add-maintenance]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const truckId = btn.dataset.addMaintenance;
      const note = document.getElementById(`maint-note-${truckId}`);
      const payload = {
        date: document.getElementById(`maint-date-${truckId}`).value,
        type: document.getElementById(`maint-type-${truckId}`).value.trim(),
        mileageKm: document.getElementById(`maint-km-${truckId}`).value,
        cost: document.getElementById(`maint-cost-${truckId}`).value,
        notes: document.getElementById(`maint-notes-${truckId}`).value.trim(),
      };
      try {
        await api('POST', `/api/admin/garage/trucks/${truckId}/maintenance`, payload);
        note.classList.remove('error');
        note.style.color = 'var(--teal)';
        note.textContent = 'Ajouté ✓';
        ['date', 'type', 'km', 'cost', 'notes'].forEach(f => { document.getElementById(`maint-${f}-${truckId}`).value = ''; });
        renderMaintenanceList(truckId);
        // Le kilométrage a pu être mis à jour automatiquement côté serveur si ce relevé est le plus récent.
        document.getElementById(`mileage-${truckId}`).value = payload.mileageKm || document.getElementById(`mileage-${truckId}`).value;
      } catch (err) {
        note.classList.add('error');
        note.textContent = err.message;
      }
    });
  });
}

async function renderMaintenanceList(truckId) {
  const { maintenance } = await api('GET', `/api/admin/garage/trucks/${truckId}/maintenance`);
  const el = document.getElementById(`maintenance-list-${truckId}`);
  if (maintenance.length === 0) {
    el.innerHTML = '<p class="empty-note">Aucun entretien enregistré pour le moment.</p>';
    return;
  }
  el.innerHTML = maintenance.map(m => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line);font-size:12.5px;">
      <div>
        <b>${new Date(m.date).toLocaleDateString('fr-FR')}</b> — ${m.type}
        ${m.mileageKm != null ? ` · ${m.mileageKm.toLocaleString('fr-FR')} km` : ''}
        ${m.cost != null ? ` · ${m.cost.toFixed(2)} €` : ''}
        ${m.notes ? `<div style="color:var(--steel);margin-top:2px;">${m.notes}</div>` : ''}
      </div>
      <button data-delete-maintenance="${m.id}" style="background:none;border:none;color:var(--rust);cursor:pointer;font-size:14px;" aria-label="Supprimer">✕</button>
    </div>
  `).join('');
  el.querySelectorAll('[data-delete-maintenance]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Supprimer cette entrée d\'entretien ?')) return;
      await api('DELETE', `/api/admin/garage/maintenance/${btn.dataset.deleteMaintenance}`);
      renderMaintenanceList(truckId);
    });
  });
}


let manualOrderClientsCache = [];

function closeManualOrderModal() {
  document.getElementById('manual-order-modal').classList.remove('open');
}
document.getElementById('manual-order-modal-close').addEventListener('click', closeManualOrderModal);
document.getElementById('manual-order-modal').addEventListener('click', e => {
  if (e.target.id === 'manual-order-modal') closeManualOrderModal();
});

async function openManualOrderModal(context) {
  // context : 'kanban' (Préparation de commande, statut "Reçue" par défaut)
  //        ou 'production' (Production, statut "En traitement" direct)
  if (manualOrderClientsCache.length === 0) {
    const { clients } = await api('GET', '/api/admin/clients');
    manualOrderClientsCache = clients;
  }

  const isProduction = context === 'production';
  const inner = document.getElementById('manual-order-modal-inner');
  inner.innerHTML = `
    <h3 style="font-family:'Fredoka',sans-serif;font-size:18px;margin-bottom:16px;">
      ${isProduction ? 'Nouvel ordre de lavage' : 'Nouvelle commande'}
    </h3>

    <div class="field">
      <label>Hôtel</label>
      <select id="mo-client-select">
        <option value="">— Client non enregistré (saisir à la main) —</option>
        ${manualOrderClientsCache.map(c => `<option value="${c.id}">${c.societe}</option>`).join('')}
      </select>
    </div>

    <div id="mo-manual-client-fields">
      <div class="field-row">
        <div class="field"><label>Société *</label><input id="mo-societe" placeholder="Ex. Hôtel Verlaine"></div>
        <div class="field"><label>Contact (optionnel)</label><input id="mo-contact" placeholder="Ex. Camille Roux"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Téléphone (optionnel)</label><input id="mo-tel"></div>
        <div class="field"><label>Adresse (optionnel)</label><input id="mo-adresse"></div>
      </div>
    </div>

    <div class="field-row">
      <div class="field"><label>Date de livraison prévue</label><input type="date" id="mo-livraison"></div>
      ${isProduction ? `
      <div class="field">
        <label>Étape de départ</label>
        <select id="mo-stage">
          ${PRODUCTION_STAGES.map(s => `<option value="${s.id}">${s.label}</option>`).join('')}
        </select>
      </div>` : ''}
    </div>

    <label style="display:block;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:var(--steel);margin:14px 0 4px;font-weight:500;">Articles</label>
    <div class="qty-grid" id="mo-items-grid"></div>

    <div class="field"><label>Notes (optionnel)</label><input id="mo-notes"></div>

    <button class="btn-primary" id="mo-submit" style="width:auto;margin-top:12px;">Créer</button>
    <div class="qty-save-note" id="mo-error"></div>
  `;
  renderQtyGrid('mo-items-grid', []);

  const clientSelect = document.getElementById('mo-client-select');
  const manualFields = document.getElementById('mo-manual-client-fields');
  clientSelect.addEventListener('change', () => {
    manualFields.style.display = clientSelect.value ? 'none' : 'block';
  });

  document.getElementById('mo-submit').addEventListener('click', () => submitManualOrder(context));

  document.getElementById('manual-order-modal').classList.add('open');
}

async function submitManualOrder(context) {
  const errorNote = document.getElementById('mo-error');
  const clientId = document.getElementById('mo-client-select').value || null;
  const items = collectQtyGrid('mo-items-grid');

  if (!clientId && !document.getElementById('mo-societe').value.trim()) {
    errorNote.textContent = 'La société est requise (ou choisissez un hôtel enregistré ci-dessus).';
    errorNote.classList.add('error');
    return;
  }
  if (items.length === 0) {
    errorNote.textContent = 'Sélectionnez au moins un article.';
    errorNote.classList.add('error');
    return;
  }

  const payload = {
    clientId,
    societe: document.getElementById('mo-societe').value.trim(),
    contact: document.getElementById('mo-contact').value.trim(),
    tel: document.getElementById('mo-tel').value.trim(),
    adresse: document.getElementById('mo-adresse').value.trim(),
    items,
    livraisonPrevue: document.getElementById('mo-livraison').value,
    notes: document.getElementById('mo-notes').value.trim(),
    status: context === 'production' ? 'traitement' : 'recue',
    productionStage: context === 'production' ? document.getElementById('mo-stage').value : undefined,
  };

  try {
    const { ticket } = await api('POST', '/api/admin/orders/manual', payload);
    errorNote.classList.remove('error');
    errorNote.style.color = 'var(--teal)';
    errorNote.textContent = `Commande ${ticket} créée ✓`;
    document.getElementById('mo-submit').disabled = true;
    if (context === 'production') renderProductionKanban();
    else refreshAdmin();
    setTimeout(closeManualOrderModal, 1100);
  } catch (err) {
    errorNote.textContent = err.message;
    errorNote.classList.add('error');
  }
}

document.getElementById('btn-new-manual-order').addEventListener('click', () => openManualOrderModal('kanban'));
document.getElementById('btn-new-manual-production').addEventListener('click', () => openManualOrderModal('production'));

const ADMIN_VIEWS = ['production', 'kanban', 'logistics', 'stats', 'historique', 'articles', 'garage', 'clients', 'facture', 'settings'];

function switchAdminView(view) {
  const allButtons = document.querySelectorAll('.admin-subnav > button, .admin-subnav-more-menu button');
  allButtons.forEach(b => b.classList.toggle('active', b.dataset.adminView === view));
  const moreMenuHasActive = !!document.querySelector('.admin-subnav-more-menu button.active');
  document.querySelector('.admin-subnav-more').classList.toggle('has-active', moreMenuHasActive);
  ADMIN_VIEWS.forEach(v => {
    document.getElementById('admin-view-' + v).style.display = v === view ? 'block' : 'none';
  });
  if (view === 'production') renderProductionKanban();
  if (view === 'kanban') refreshAdmin();
  if (view === 'logistics') renderLogisticsView();
  if (view === 'stats') renderStats();
  if (view === 'historique') { renderHistoryFilters(); renderHistoryList(); }
  if (view === 'articles') renderArticlesView();
  if (view === 'facture') renderFactureTab();
  if (view === 'garage') renderGarageView();
  if (view === 'clients') renderClientsView();
  if (view === 'settings') renderSettingsPanel();
}
document.querySelectorAll('.admin-subnav > button, .admin-subnav-more-menu button').forEach(btn => {
  btn.addEventListener('click', () => {
    switchAdminView(btn.dataset.adminView);
    document.getElementById('admin-more-menu').classList.remove('open');
  });
});

// Menu "Plus" : ouverture/fermeture au clic, fermeture si on clique ailleurs.
document.getElementById('admin-more-toggle').addEventListener('click', e => {
  e.stopPropagation();
  document.getElementById('admin-more-menu').classList.toggle('open');
});
document.addEventListener('click', e => {
  const menu = document.getElementById('admin-more-menu');
  if (menu.classList.contains('open') && !menu.contains(e.target) && e.target.id !== 'admin-more-toggle') {
    menu.classList.remove('open');
  }
});

// ---------- types de chambre : aide pour la grille de quantités par article ----------
function renderQtyGrid(containerId, existingItems) {
  const map = Object.fromEntries((existingItems || []).map(i => [i.serviceId, i.qty]));
  const el = document.getElementById(containerId);
  el.innerHTML = SERVICES.map(s => `
    <div class="qty-grid-item">
      <label>${s.code}</label>
      <input type="number" min="0" data-service="${s.id}" value="${map[s.id] || 0}">
    </div>
  `).join('');
}
function collectQtyGrid(containerId) {
  const el = document.getElementById(containerId);
  return [...el.querySelectorAll('input')]
    .map(input => ({ serviceId: input.dataset.service, qty: parseInt(input.value, 10) || 0 }))
    .filter(i => i.qty > 0);
}

function renderHistoryFilters() {
  const select = document.getElementById('hist-client');
  const current = select.value;
  const clients = [...new Set(
    adminOrdersCache.filter(o => o.status === 'livree').map(o => o.client.societe)
  )].sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="">Tous les clients</option>' + clients.map(c => `<option value="${c}">${c}</option>`).join('');
  select.value = clients.includes(current) ? current : '';
}

function renderHistoryList() {
  const from = document.getElementById('hist-date-from').value;
  const to = document.getElementById('hist-date-to').value;
  const client = document.getElementById('hist-client').value;

  let list = adminOrdersCache.filter(o => o.status === 'livree');
  if (from) list = list.filter(o => new Date(o.createdAt) >= new Date(from));
  if (to) list = list.filter(o => new Date(o.createdAt) <= new Date(to + 'T23:59:59'));
  if (client) list = list.filter(o => o.client.societe === client);
  list = [...list].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const box = document.getElementById('history-list');
  if (list.length === 0) {
    box.innerHTML = '<p class="history-empty">Aucune commande livrée ne correspond à ces filtres.</p>';
    return;
  }
  box.innerHTML = list.map(o => `
    <div class="own-ticket livree" data-id="${o.id}" tabindex="0" role="button" aria-label="Voir le détail de la commande ${o.ticket}">
      <div>
        <span class="mini-num">${o.ticket}</span>
        <span class="mini-sub">${o.client.societe} · ${o.items.length} réf. · ${new Date(o.createdAt).toLocaleDateString('fr-FR')}</span>
      </div>
      <span class="own-badge livree">Livrée</span>
    </div>
  `).join('');
  box.querySelectorAll('.own-ticket').forEach(el => {
    el.addEventListener('click', () => openOrderModal(el.dataset.id, 'historique'));
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOrderModal(el.dataset.id, 'historique'); } });
  });
}

['hist-date-from', 'hist-date-to', 'hist-client'].forEach(id => {
  document.getElementById(id).addEventListener('change', renderHistoryList);
});
document.getElementById('btn-hist-reset').addEventListener('click', () => {
  document.getElementById('hist-date-from').value = '';
  document.getElementById('hist-date-to').value = '';
  document.getElementById('hist-client').value = '';
  renderHistoryList();
});

// ---------- navigation ----------
function switchView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.remove('active'));
  const navBtn = document.querySelector(`nav.tabs button[data-view="${name === 'confirmation' ? 'commander' : name}"]`);
  if (navBtn) navBtn.classList.add('active');
  if (name === 'admin') renderAdminGate();
  if (name === 'espace') renderEspace();
  if (name === 'commander') prefillOrderFormIfLoggedIn();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.querySelectorAll('nav.tabs button').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});
document.getElementById('footer-admin-link').addEventListener('click', () => switchView('admin'));
document.getElementById('brand-home-link').addEventListener('click', () => switchView('espace'));
document.getElementById('brand-home-link').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchView('espace'); } });

// ---------- init ----------
(async function init() {
  try {
    await loadServices();
  } catch (err) {
    console.error('Impossible de charger le catalogue de services :', err);
  }
  renderHomeServices();
  renderServiceList();
  renderSummary();

  try {
    const { client } = await api('GET', '/api/clients/me');
    currentClient = client;
  } catch (err) { /* pas connecté, on continue normalement */ }
  renderEspace(); // la page s'ouvre désormais sur "Mon espace" par défaut
})();
