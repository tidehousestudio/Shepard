const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const products = [
  { id: 1, name: 'House Blend', price: 12 },
  { id: 2, name: 'Sourdough Loaf', price: 6 },
];
const carts = new Map();

app.get('/api/products', (req, res) => res.json(products));

app.post('/api/cart', (req, res) => {
  const id = req.body && req.body.productId;
  const found = products.find(p => p.id === id);
  if (!found) return res.status(404).json({ error: 'no such product' });
  const cart = carts.get('demo') || [];
  cart.push(found);
  carts.set('demo', cart);
  res.json({ count: cart.length });
});

app.get('/api/cart', (req, res) => res.json({ items: carts.get('demo') || [] }));

app.get('/admin/orders', (req, res) => {
  if (req.headers['x-role'] !== 'admin') return res.status(403).json({ error: 'forbidden' });
  res.json({ orders: [] });
});

const page = name => (req, res) => res.sendFile(path.join(__dirname, 'public', name));
app.get('/', page('index.html'));
app.get('/products', page('products.html'));
app.get('/cart', page('cart.html'));
app.get('/account', page('account.html'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('demo-shop on ' + port));
