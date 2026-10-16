const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('redis');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const cache = createClient({ url: process.env.REDIS_URL });
cache.connect().catch((e) => console.error('Redis no disponible', e));

app.get('/salud', (req, res) => res.json({ estado: 'ok' }));

app.get('/libros', async (req, res) => {
  const enCache = await cache.get('libros');
  if (enCache) return res.json(JSON.parse(enCache));
  const { rows } = await pool.query('SELECT id, titulo, autor, precio FROM libros ORDER BY id');
  await cache.set('libros', JSON.stringify(rows), { EX: 60 });
  res.json(rows);
});

app.post('/pedidos', async (req, res) => {
  const { libroId, unidades } = req.body;
  if (!libroId || !unidades) return res.status(400).json({ error: 'Faltan datos' });
  const { rows } = await pool.query(
    'INSERT INTO pedidos (libro_id, unidades) VALUES ($1, $2) RETURNING id',
    [libroId, unidades]
  );
  await cache.lPush('cola:facturas', String(rows[0].id));
  res.status(201).json({ pedido: rows[0].id });
});

app.listen(process.env.PORT || 3000, () => console.log('API escuchando'));
