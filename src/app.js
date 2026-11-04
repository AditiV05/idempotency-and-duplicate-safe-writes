const express = require('express');
const { auth } = require('./auth');
const { createIncident } = require('./incidents');
const app = express();
app.use(express.json());
app.post('/incidents', auth, (req, res, next) => createIncident(req, res).catch(next));
app.use((err, req, res, next) => {
  // A malformed body is the client's error, and retrying it will not help.
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'invalid_request' });
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});
module.exports = { app };
