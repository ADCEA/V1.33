require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');

const { getServicesForClient, CATEGORIES } = require('./services');
const clientsRouter = require('./routes/clients');
const ordersRouter = require('./routes/orders');
const adminRouter = require('./routes/admin');
const webhooksRouter = require('./routes/webhooks');
const roomTypesRouter = require('./routes/roomTypes');
const productionRouter = require('./routes/production');
const logisticsRouter = require('./routes/logistics');
const statsRouter = require('./routes/stats');
const articlesRouter = require('./routes/articles');
const driverPortalRouter = require('./routes/driverPortal');
const garageRouter = require('./routes/garage');
const apiV1Router = require('./routes/apiV1');
const { startInvoiceStatusScheduler } = require('./utils/invoiceStatusSync');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET) {
  console.warn(
    '⚠️  SESSION_SECRET absent du .env — une valeur temporaire est utilisée, ' +
    'les sessions seront invalidées à chaque redémarrage. Copiez .env.example en .env et renseignez-le.'
  );
}

app.use(express.json());
app.use(session({
  name: 'cezanne.sid',
  secret: process.env.SESSION_SECRET || 'dev-secret-non-persistant',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 jours
  },
}));

// Les réponses d'API ne doivent jamais être mises en cache (par le
// navigateur ou un intermédiaire) : ce sont des données qui changent
// constamment (catalogue, commandes...), et un cache silencieux donnerait
// l'impression qu'une modification pourtant bien enregistrée n'a aucun
// effet à l'affichage.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Catalogue filtré selon le client connecté : s'il a des articles qui lui
// sont spécifiquement attribués (Administration → Gestion des articles),
// seuls ceux-là sont renvoyés. Sinon (invité, ou hôtel sans attribution
// particulière), le catalogue complet, comme avant.
app.get('/api/services', (req, res) => {
  const services = getServicesForClient(req.session.clientId || null);
  res.json({ services, categories: CATEGORIES });
});

app.use('/api/clients', clientsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/admin', adminRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/admin/room-types', roomTypesRouter);
app.use('/api/admin/production', productionRouter);
app.use('/api/admin/logistics', logisticsRouter);
app.use('/api/admin/stats', statsRouter);
app.use('/api/admin/articles', articlesRouter);
app.use('/api/driver-portal', driverPortalRouter);
app.use('/api/admin/garage', garageRouter);
app.use('/api/v1', apiV1Router);

app.use(express.static(path.join(__dirname, '..', 'public')));

// Toute route non-API renvoie l'app (single page)
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur.' });
});

app.listen(PORT, () => {
  console.log(`Blanchisserie Cézanne — serveur lancé sur http://localhost:${PORT}`);
  startInvoiceStatusScheduler();
});
