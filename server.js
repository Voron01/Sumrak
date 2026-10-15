const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || null;

const clients = new Map();
const usedNames = new Set();
let nextId = 1;

// === РЕКОРДЫ (топ-3 по каждой игре) ===
const records = { cat: [], bomber: [], match3: [], flappy: [] };
const MAX_RECORDS = 3;

function broadcast(obj, except) {
  const str = JSON.stringify(obj);
  for (const [c] of clients) {
    if (c === except) continue;
    if (c.readyState === 1) try { c.send(str); } catch (e) {}
  }
}

function pushRecord(game, name, score) {
  if (!records[game]) records[game] = [];
  records[game] = records[game].filter(r => r.name !== name);
  records[game].push({ name, score, time: Date.now() });
  records[game].sort((a, b) => b.score - a.score);
  records[game] = records[game].slice(0, MAX_RECORDS);
}

const server = http.createServer((req, res) => {
  // === Health-check для Render ===
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('OK');
    return;
  }

  if (req.method !== 'GET') { res.writeHead(405); res.end('Method not allowed'); return; }
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(__dirname, urlPath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found: ' + urlPath); return; }
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const id = 'p' + (nextId++);
  clients.set(ws, { id, name: null, color: null, custom: null, clan: null });
  console.log('[+] Подключился ' + id);

  const existingPlayers = [];
  for (const [c, data] of clients) {
    if (c !== ws && data.name) {
      existingPlayers.push({
        id: data.id, name: data.name, color: data.color,
        custom: data.custom, clan: data.clan
      });
    }
  }
  ws.send(JSON.stringify({ t: 'welcome', id, players: existingPlayers, records }));

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    m.id = id;
    const clientData = clients.get(ws);

    if (m.t === 'join' && m.name) {
      const nameLower = m.name.toLowerCase();
      let taken = false;
      for (const [c, data] of clients) {
        if (c !== ws && data.name && data.name.toLowerCase() === nameLower) {
          taken = true; break;
        }
      }
      if (taken) { ws.send(JSON.stringify({ t: 'nameTaken' })); return; }
      clientData.name = m.name;
      clientData.color = m.color;
      clientData.custom = m.custom;
      clientData.clan = m.clan;
      usedNames.add(nameLower);
    }

    if (m.t === 'custom' && clientData) clientData.custom = m.custom;
    if (m.t === 'clanUpdate' && clientData) clientData.clan = m.name;
    if (m.t === 'sync' && clientData) {
      if (m.name) clientData.name = m.name;
      if (m.color !== undefined) clientData.color = m.color;
      if (m.custom !== undefined) clientData.custom = m.custom;
      if (m.clan !== undefined) clientData.clan = m.clan;
    }

    // === РЕКОРД ===
    if (m.t === 'record' && m.game && typeof m.score === 'number') {
      if (!clientData.name) return;
      pushRecord(m.game, clientData.name, m.score);
      broadcast({ t: 'records', records });
      return;
    }
    if (m.t === 'getRecords') {
      ws.send(JSON.stringify({ t: 'records', records }));
      return;
    }

    // === INVITE / RESPONSE ===
    if (m.t === 'invite' || m.t === 'inviteResponse') {
      const str = JSON.stringify(m);
      for (const [c, data] of clients) {
        if (data.id === m.to || data.id === m.id) {
          if (c.readyState === 1) try { c.send(str); } catch (e) {}
        }
      }
      return;
    }

    const str = JSON.stringify(m);
    for (const [c] of clients) {
      if (c !== ws && c.readyState === 1) try { c.send(str); } catch (e) {}
    }
  });

  ws.on('close', () => {
    const data = clients.get(ws);
    if (data && data.name) usedNames.delete(data.name.toLowerCase());
    console.log('[-] Отключился ' + id);
    broadcast({ t: 'leave', id });
    clients.delete(ws);
  });

  ws.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('=================================');
  console.log('  СУМРАК — сервер запущен');
  console.log('  Порт: ' + PORT);
  console.log('=================================');
  console.log('');
  console.log('  Играть:');
  console.log('    http://localhost:' + PORT);
  console.log('    http://<твой-IP>:' + PORT + '  ← дай друзьям');
  console.log('=================================');

  // === Self-ping: не даём Render усыпить сервер ===
  if (SELF_URL) {
    const url = SELF_URL.replace(/\/$/, '') + '/health';
    const lib = url.startsWith('https') ? require('https') : http;
    console.log('[Self-ping] Пингую ' + url + ' каждые 14 минут');
    setInterval(() => {
      lib.get(url, (res) => {
        console.log('[Self-ping] ' + new Date().toISOString() + ' → ' + res.statusCode);
      }).on('error', (e) => {
        console.log('[Self-ping] Ошибка: ' + e.message);
      });
    }, 14 * 60 * 1000);
  } else {
    console.log('[Self-ping] Отключён (нет RENDER_EXTERNAL_URL)');
  }
});