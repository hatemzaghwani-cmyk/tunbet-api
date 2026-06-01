import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'tunbet-secret-2026-legendary';
const ODDS_API_KEY = process.env.ODDS_API_KEY || 'c98984e5e340c3df58f0356ca7f1afe0';
const AES_TOKEN = process.env.AES_TOKEN || '290c38c7-7df8-4913-9f77-2865e31f1edc';

// ─── Database ───────────────────────────────────────────────────────────────
const db = new Database(join(__dirname, '..', 'data', 'tunbet.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT,
    role TEXT NOT NULL DEFAULT 'player',
    balance REAL NOT NULL DEFAULT 0,
    agent_id INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    aes_player_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    balance_before REAL NOT NULL,
    balance_after REAL NOT NULL,
    description TEXT,
    performed_by INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS sports_bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    event_name TEXT NOT NULL,
    sport TEXT,
    league TEXT,
    selection TEXT NOT NULL,
    selection_name TEXT NOT NULL,
    odds REAL NOT NULL,
    stake REAL NOT NULL,
    potential_win REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payout REAL DEFAULT 0,
    commence_time TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    settled_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Seed admin
const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('superadmin');
if (!adminExists) {
  const hash = bcrypt.hashSync('Casino2026!', 10);
  db.prepare('INSERT INTO users (username, password_hash, role, balance) VALUES (?, ?, ?, ?)').run('legendary_admin', hash, 'superadmin', 0);
  console.log('Admin account created');
}

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function adminOnly(req, res, next) {
  auth(req, res, () => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

// ─── Auth Routes ────────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'اسم المستخدم وكلمة السر مطلوبة' });
  
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'اسم المستخدم موجود مسبقاً' });
  
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, password_hash, email, role, balance) VALUES (?, ?, ?, ?, ?)').run(username, hash, email || null, 'player', 0);
  
  const token = jwt.sign({ userId: result.lastInsertRowid, username, role: 'player' }, JWT_SECRET, { expiresIn: '30d' });
  res.status(201).json({ token, user: { id: result.lastInsertRowid, username, role: 'player', balance: '0.00' } });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'بيانات خاطئة' });
  
  const token = jwt.sign({ userId: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, balance: user.balance.toFixed(2) } });
});

app.post('/api/auth/admin-login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND role = ?').get(username, 'superadmin');
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'بيانات خاطئة' });
  
  const token = jwt.sign({ userId: user.id, username: user.username, role: 'superadmin' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, role: 'superadmin' });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, username, role, balance, email FROM users WHERE id = ?').get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ ...user, balance: user.balance.toFixed(2) });
});

app.get('/api/balance', auth, (req, res) => {
  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.userId);
  res.json({ balance: (user?.balance || 0).toFixed(2) });
});

// ─── Admin Routes ───────────────────────────────────────────────────────────
app.get('/api/admin/stats', adminOnly, (req, res) => {
  const players = db.prepare('SELECT COUNT(*) as c FROM users WHERE role = ?').get('player');
  const agents = db.prepare('SELECT COUNT(*) as c FROM users WHERE role = ?').get('agent');
  const totalBal = db.prepare('SELECT COALESCE(SUM(balance), 0) as s FROM users WHERE role = ?').get('player');
  const txnCount = db.prepare('SELECT COUNT(*) as c FROM transactions').get();
  const betCount = db.prepare('SELECT COUNT(*) as c FROM sports_bets').get();
  res.json({ playerCount: players.c, agentCount: agents.c, totalBalance: totalBal.s.toFixed(2), txnCount: txnCount.c, betCount: betCount.c });
});

app.get('/api/admin/users', adminOnly, (req, res) => {
  const role = req.query.role;
  const users = role
    ? db.prepare('SELECT id, username, email, role, balance, is_active, agent_id, created_at FROM users WHERE role = ? ORDER BY id DESC').all(role)
    : db.prepare('SELECT id, username, email, role, balance, is_active, agent_id, created_at FROM users ORDER BY id DESC').all();
  res.json(users.map(u => ({ ...u, balance: u.balance.toFixed(2), isActive: !!u.is_active })));
});

app.post('/api/admin/users', adminOnly, (req, res) => {
  const { username, password, email, role, agentId } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'مطلوب اسم مستخدم وكلمة سر' });
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'اسم المستخدم موجود' });
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, password_hash, email, role, balance, agent_id) VALUES (?, ?, ?, ?, 0, ?)').run(username, hash, email || null, role || 'player', agentId || null);
  res.status(201).json({ id: result.lastInsertRowid, username, role: role || 'player', balance: '0.00' });
});

app.delete('/api/admin/users/:id', adminOnly, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.sendStatus(204);
});

app.post('/api/admin/users/:id/balance', adminOnly, (req, res) => {
  const { action, amount } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
  
  const current = user.balance;
  let newBal = current, txnType = 'deposit', txnAmount = 0;
  
  if (action === 'add') {
    if (!amount || amount <= 0) return res.status(400).json({ error: 'المبلغ غير صحيح' });
    newBal = Math.round((current + amount) * 100) / 100;
    txnType = 'deposit'; txnAmount = amount;
  } else if (action === 'withdraw') {
    if (!amount || amount <= 0) return res.status(400).json({ error: 'المبلغ غير صحيح' });
    if (current < amount) return res.status(400).json({ error: 'الرصيد غير كافي' });
    newBal = Math.round((current - amount) * 100) / 100;
    txnType = 'withdraw'; txnAmount = -amount;
  } else if (action === 'reset') {
    newBal = 0; txnType = 'reset'; txnAmount = -current;
  }
  
  db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBal, user.id);
  db.prepare('INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description, performed_by) VALUES (?, ?, ?, ?, ?, ?, 0)').run(user.id, txnType, txnAmount, current, newBal, `Admin ${action}: ${Math.abs(txnAmount).toFixed(2)} TND`);
  
  res.json({ balance: newBal });
});

app.get('/api/admin/transactions', adminOnly, (req, res) => {
  const txns = db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT 200').all();
  res.json(txns.map(t => ({ ...t, amount: t.amount.toFixed(2), balanceBefore: t.balance_before.toFixed(2), balanceAfter: t.balance_after.toFixed(2) })));
});

app.get('/api/admin/agents', adminOnly, (req, res) => {
  const agents = db.prepare('SELECT id, username, email, role, balance, is_active, created_at FROM users WHERE role = ?').all('agent');
  res.json(agents.map(a => ({ ...a, balance: a.balance.toFixed(2), isActive: !!a.is_active })));
});

app.post('/api/admin/agents/:id/credit', adminOnly, (req, res) => {
  const { action, amount } = req.body;
  const agent = db.prepare('SELECT * FROM users WHERE id = ? AND role = ?').get(req.params.id, 'agent');
  if (!agent) return res.status(404).json({ error: 'الوكيل غير موجود' });
  const current = agent.balance;
  let newBal = current;
  if (action === 'add') newBal = Math.round((current + amount) * 100) / 100;
  else if (action === 'withdraw') {
    if (current < amount) return res.status(400).json({ error: 'رصيد غير كافي' });
    newBal = Math.round((current - amount) * 100) / 100;
  }
  db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBal, agent.id);
  db.prepare('INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description) VALUES (?, ?, ?, ?, ?, ?)').run(agent.id, action === 'add' ? 'deposit' : 'withdraw', action === 'add' ? amount : -amount, current, newBal, `Agent credit ${action}`);
  res.json({ balance: newBal });
});

app.get('/api/admin/bets', adminOnly, (req, res) => {
  const bets = db.prepare('SELECT * FROM sports_bets ORDER BY id DESC LIMIT 200').all();
  res.json(bets);
});

app.patch('/api/admin/bets/:id', adminOnly, (req, res) => {
  const { status } = req.body;
  if (!['won', 'lost', 'void'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const bet = db.prepare('SELECT * FROM sports_bets WHERE id = ?').get(req.params.id);
  if (!bet) return res.status(404).json({ error: 'Not found' });
  if (bet.status !== 'pending') return res.status(400).json({ error: 'Already settled' });
  
  let payout = 0;
  if (status === 'won') payout = bet.potential_win;
  else if (status === 'void') payout = bet.stake;
  
  if (payout > 0) {
    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(bet.user_id);
    const newBal = Math.round((user.balance + payout) * 100) / 100;
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBal, bet.user_id);
    db.prepare('INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description) VALUES (?, ?, ?, ?, ?, ?)').run(bet.user_id, status === 'won' ? 'win' : 'refund', payout, user.balance, newBal, `Bet ${status}: ${bet.event_name}`);
  }
  
  db.prepare('UPDATE sports_bets SET status = ?, payout = ?, settled_at = datetime("now") WHERE id = ?').run(status, payout, bet.id);
  res.json({ success: true });
});

// ─── Sports Odds Routes ─────────────────────────────────────────────────────
const oddsCache = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

app.get('/api/sports', async (req, res) => {
  try {
    if (oddsCache.sports && Date.now() - oddsCache.sports.time < CACHE_TTL) {
      return res.json(oddsCache.sports.data);
    }
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}`);
    const data = await r.json();
    oddsCache.sports = { data, time: Date.now() };
    res.json(data);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch sports' }); }
});

app.get('/api/sports/:sport/odds', async (req, res) => {
  const { sport } = req.params;
  const { markets = 'h2h,spreads,totals', regions = 'eu,us' } = req.query;
  const cacheKey = `${sport}_${markets}_${regions}`;
  
  try {
    if (oddsCache[cacheKey] && Date.now() - oddsCache[cacheKey].time < CACHE_TTL) {
      return res.json(oddsCache[cacheKey].data);
    }
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&regions=${regions}&markets=${markets}&oddsFormat=decimal`;
    const r = await fetch(url);
    const data = await r.json();
    
    // Get remaining requests
    const remaining = r.headers.get('x-requests-remaining');
    
    oddsCache[cacheKey] = { data, time: Date.now() };
    res.json({ events: data, remaining: parseInt(remaining) || 0 });
  } catch (e) { res.status(500).json({ error: 'Failed to fetch odds' }); }
});

app.get('/api/sports/scores/:sport', async (req, res) => {
  const { sport } = req.params;
  try {
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sport}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=1`);
    const data = await r.json();
    res.json(data);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch scores' }); }
});

// ─── Sports Betting Routes ──────────────────────────────────────────────────
app.post('/api/sports/bet', auth, (req, res) => {
  const { eventId, eventName, sport, league, selection, selectionName, odds, stake, commenceTime } = req.body;
  if (!eventId || !selection || !odds || !stake) return res.status(400).json({ error: 'Missing fields' });
  
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.balance < stake) return res.status(400).json({ error: 'رصيد غير كافي' });
  
  const potentialWin = Math.round(stake * odds * 100) / 100;
  const newBal = Math.round((user.balance - stake) * 100) / 100;
  
  db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBal, user.id);
  
  const result = db.prepare(`INSERT INTO sports_bets (user_id, event_id, event_name, sport, league, selection, selection_name, odds, stake, potential_win, commence_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, eventId, eventName, sport || '', league || '', selection, selectionName, odds, stake, potentialWin, commenceTime || '');
  
  db.prepare('INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, 'bet', -stake, user.balance, newBal, `Bet: ${eventName} - ${selectionName} @ ${odds}`);
  
  res.status(201).json({ bet: { id: result.lastInsertRowid }, newBalance: newBal.toFixed(2) });
});

app.get('/api/sports/my-bets', auth, (req, res) => {
  const bets = db.prepare('SELECT * FROM sports_bets WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.userId);
  res.json(bets);
});

// ─── Transactions ───────────────────────────────────────────────────────────
app.get('/api/transactions', auth, (req, res) => {
  const txns = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.userId);
  res.json(txns.map(t => ({ ...t, amount: t.amount.toFixed(2), balanceBefore: t.balance_before.toFixed(2), balanceAfter: t.balance_after.toFixed(2) })));
});

// ─── AES Gaming Proxy (for CORS) ────────────────────────────────────────────
app.post('/api/aes/:a', auth, async (req, res) => { await proxyAes(req, res, req.params.a); });
app.post('/api/aes/:a/:b', auth, async (req, res) => { await proxyAes(req, res, `${req.params.a}/${req.params.b}`); });

async function proxyAes(req, res, endpoint) {
  try {
    const r = await fetch(`https://api.aesgamingasia.com/v4/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AES_TOKEN}` },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) { res.status(500).json({ error: 'AES request failed' }); }
}

// ─── Game Launch ────────────────────────────────────────────────────────────
app.post('/api/games/launch', auth, async (req, res) => {
  const { gameCode, providerId } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.balance <= 0) return res.status(400).json({ error: 'رصيدك 0' });
  
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AES_TOKEN}` };
  
  // Ensure AES player
  let userCode = user.aes_player_id ? parseInt(user.aes_player_id) : 0;
  if (!userCode) {
    const safeName = user.username.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 50);
    const cr = await fetch('https://api.aesgamingasia.com/v4/user/create', { method: 'POST', headers, body: JSON.stringify({ name: safeName }) });
    const cd = await cr.json();
    if (cd.code === 0 && cd.data?.user_code) {
      userCode = cd.data.user_code;
      db.prepare('UPDATE users SET aes_player_id = ? WHERE id = ?').run(String(userCode), user.id);
    } else return res.status(502).json({ error: 'فشل إنشاء حساب اللعب' });
  }
  
  // Deposit balance
  await fetch('https://api.aesgamingasia.com/v4/wallet/withdraw-all', { method: 'POST', headers, body: JSON.stringify({ user_code: userCode }) });
  await fetch('https://api.aesgamingasia.com/v4/wallet/deposit', { method: 'POST', headers, body: JSON.stringify({ user_code: userCode, amount: user.balance }) });
  
  // Get game URL
  const r = await fetch('https://api.aesgamingasia.com/v4/game/game-url', { method: 'POST', headers, body: JSON.stringify({ user_code: userCode, provider_id: providerId, game_symbol: gameCode, lang: 1, return_url: req.headers.origin || 'https://tunbet.surge.sh' }) });
  const d = await r.json();
  const gameUrl = d.data?.game_url || d.data?.url;
  if (d.code === 0 && gameUrl) return res.json({ url: gameUrl });
  res.status(502).json({ error: 'اللعبة غير متاحة' });
});

app.post('/api/games/sync-balance', auth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
  if (!user?.aes_player_id) return res.json({ balance: (user?.balance || 0).toFixed(2) });
  
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AES_TOKEN}` };
  const userCode = parseInt(user.aes_player_id);
  
  const wr = await fetch('https://api.aesgamingasia.com/v4/wallet/withdraw-all', { method: 'POST', headers, body: JSON.stringify({ user_code: userCode }) });
  const wd = await wr.json();
  
  if (wd.code === 0) {
    const realBal = parseFloat(wd.data?.amount ?? 0);
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(realBal, user.id);
    res.json({ balance: realBal.toFixed(2) });
  } else {
    res.json({ balance: user.balance.toFixed(2) });
  }
});

// ─── Health Check ───────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), users: db.prepare('SELECT COUNT(*) as c FROM users').get().c });
});

app.get('/', (req, res) => {
  res.json({ name: 'TunBet API', version: '1.0.0', status: 'running' });
});

// ─── Create data directory ──────────────────────────────────────────────────
import { mkdirSync, existsSync } from 'fs';
const dataDir = join(__dirname, '..', 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

// ─── Start Server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 TunBet API running on port ${PORT}`);
  console.log(`📊 Database: ${join(__dirname, '..', 'data', 'tunbet.db')}`);
  
  // Self-ping every 14 minutes to prevent Render free tier sleep
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.KOYEB_PUBLIC_DOMAIN || null;
  if (SELF_URL) {
    setInterval(() => {
      fetch(`${SELF_URL}/api/health`).catch(() => {});
    }, 14 * 60 * 1000);
    console.log(`⏰ Self-ping enabled: ${SELF_URL}`);
  }
});
