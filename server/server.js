/**
 * Dictation Server v3
 * 
 * Workflow:
 * 1. Admin importiert Lizenz → Server aktiviert gegen PHP-Lizenzserver
 * 2. Lizenz: max_concurrent_users (gleichzeitig verbundene Benutzer), max_devices
 * 3. Admin legt beliebig viele Benutzer an
 * 4. Auto-Pairing: Gleicher User auf Mobile+Desktop = automatisch verbunden
 * 5. Nur X Benutzer können gleichzeitig verbunden sein
 */

const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const url = require('url');
const fs = require('fs');
const path = require('path');

// Config
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_DURATION = 30 * 24 * 60 * 60 * 1000;
const DATA_DIR = process.env.DATA_DIR || './data';
const LICENSE_SERVER_URL = process.env.LICENSE_SERVER_URL || 'http://localhost:8083/api.php';
const LICENSE_SERVER_SECRET = process.env.LICENSE_SERVER_SECRET || 'license-server-secret-key';
const SERVER_ID = process.env.SERVER_ID || 'srv_' + crypto.randomBytes(4).toString('hex');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================================
// Database
// ============================================================================
class DB {
    constructor(file) {
        this.file = path.join(DATA_DIR, file);
        this.data = {};
        try { if (fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    }
    save() { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
    table(n) { if (!this.data[n]) this.data[n] = []; return this.data[n]; }
    insert(t, r) { r.id = crypto.randomUUID(); r.created_at = new Date().toISOString(); this.table(t).push(r); this.save(); return r; }
    update(t, id, u) { const arr = this.table(t); const i = arr.findIndex(x => x.id === id); if (i >= 0) { arr[i] = {...arr[i], ...u}; this.save(); return arr[i]; } return null; }
    delete(t, id) { const arr = this.table(t); const i = arr.findIndex(x => x.id === id); if (i >= 0) { arr.splice(i, 1); this.save(); return true; } return false; }
    find(t, id) { return this.table(t).find(x => x.id === id); }
    findOne(t, fn) { return this.table(t).find(fn); }
    findAll(t, fn) { return fn ? this.table(t).filter(fn) : [...this.table(t)]; }
    count(t, fn) { return this.findAll(t, fn).length; }
    get(k) { return this.data[k]; }
    set(k, v) { this.data[k] = v; this.save(); }
}

const db = new DB('data.json');

// ============================================================================
// Utils
// ============================================================================
const hash = pw => crypto.createHash('sha256').update(pw + JWT_SECRET).digest('hex');
const verify = (pw, h) => hash(pw) === h;
const genToken = () => crypto.randomBytes(48).toString('base64url');

// ============================================================================
// License Server Client
// ============================================================================
async function callLicenseServer(endpoint, method, body = null) {
    return new Promise((resolve, reject) => {
        const u = new URL(LICENSE_SERVER_URL + endpoint);
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request({
            hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search, method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LICENSE_SERVER_SECRET}` }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    res.statusCode >= 400 ? reject(new Error(json.error || 'License error')) : resolve(json);
                } catch { reject(new Error('Invalid license server response')); }
            });
        });
        req.on('error', () => reject(new Error('Cannot connect to license server')));
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('License server timeout')); });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// ============================================================================
// Init
// ============================================================================
function init() {
    if (db.count('users') === 0) {
        const pw = process.env.ADMIN_PASSWORD || 'admin123';
        db.insert('users', { email: 'admin@localhost', password_hash: hash(pw), name: 'Administrator', role: 'admin', is_active: true });
        console.log('✓ Admin created: admin@localhost / ' + pw);
    }
    const lic = db.get('license');
    if (lic?.activation_id) {
        console.log('✓ License active - Max ' + lic.max_concurrent_users + ' concurrent users, ' + lic.max_devices + ' devices');
    } else {
        console.log('⚠ No license - import one in Admin Tool');
    }
}

// ============================================================================
// Session
// ============================================================================
function createSession(userId, deviceType) {
    const token = genToken();
    db.insert('sessions', { user_id: userId, device_type: deviceType, token, expires_at: new Date(Date.now() + SESSION_DURATION).toISOString() });
    return token;
}

function validateSession(token) {
    const s = db.findOne('sessions', x => x.token === token);
    if (!s || new Date(s.expires_at) < new Date()) { if (s) db.delete('sessions', s.id); return null; }
    const u = db.find('users', s.user_id);
    if (!u || !u.is_active) return null;
    return { session: s, user: u };
}

// ============================================================================
// Connection Tracking (für gleichzeitige Limits)
// ============================================================================
// activeUsers: Map<userId, { mobile: ws|null, desktop: ws|null }>
const activeUsers = new Map();

function getConnectedUserCount() { return activeUsers.size; }
function getConnectedDeviceCount() {
    let c = 0;
    for (const [_, d] of activeUsers) { if (d.mobile) c++; if (d.desktop) c++; }
    return c;
}

function canUserConnect(userId, deviceType) {
    const lic = db.get('license');
    if (!lic?.activation_id) return { ok: false, error: 'Keine Lizenz aktiviert' };
    
    // Prüfen ob User schon verbunden ist
    const existing = activeUsers.get(userId);
    if (existing?.[deviceType]) return { ok: true }; // Reconnect erlaubt
    
    // Neuer User?
    if (!activeUsers.has(userId)) {
        if (getConnectedUserCount() >= lic.max_concurrent_users) {
            return { ok: false, error: `Max. ${lic.max_concurrent_users} gleichzeitige Benutzer erreicht` };
        }
    }
    
    // Geräte-Limit
    if (getConnectedDeviceCount() >= lic.max_devices) {
        return { ok: false, error: `Max. ${lic.max_devices} gleichzeitige Geräte erreicht` };
    }
    
    return { ok: true };
}

function registerConnection(userId, deviceType, ws, userName) {
    if (!activeUsers.has(userId)) activeUsers.set(userId, { mobile: null, desktop: null, name: userName });
    const u = activeUsers.get(userId);
    
    // Alte Verbindung schließen
    if (u[deviceType]) u[deviceType].close(4000, 'Replaced');
    u[deviceType] = ws;
    
    // Auto-Pairing: beide verbunden?
    if (u.mobile && u.desktop) {
        u.mobile.send(JSON.stringify({ type: 'paired', partner: 'desktop' }));
        u.desktop.send(JSON.stringify({ type: 'paired', partner: 'mobile' }));
        console.log(`✓ Paired: ${userName}`);
    }
}

function unregisterConnection(userId, deviceType) {
    const u = activeUsers.get(userId);
    if (!u) return;
    
    const other = deviceType === 'mobile' ? 'desktop' : 'mobile';
    if (u[other]?.readyState === 1) {
        u[other].send(JSON.stringify({ type: 'partner_disconnected' }));
    }
    
    u[deviceType] = null;
    if (!u.mobile && !u.desktop) activeUsers.delete(userId);
}

function getPartner(userId, deviceType) {
    const u = activeUsers.get(userId);
    if (!u) return null;
    return deviceType === 'mobile' ? u.desktop : u.mobile;
}

function isPaired(userId) {
    const u = activeUsers.get(userId);
    return u?.mobile && u?.desktop;
}

// ============================================================================
// HTTP Routes
// ============================================================================
const routes = {
    'POST /api/auth/login': async (req, body) => {
        const { email, password, device_type } = body;
        if (!email || !password) return { status: 400, body: { error: 'E-Mail und Passwort erforderlich' } };
        if (!['mobile', 'desktop'].includes(device_type)) return { status: 400, body: { error: 'device_type muss mobile oder desktop sein' } };
        
        const user = db.findOne('users', u => u.email.toLowerCase() === email.toLowerCase());
        if (!user || !verify(password, user.password_hash)) return { status: 401, body: { error: 'Ungültige Anmeldedaten' } };
        if (!user.is_active) return { status: 403, body: { error: 'Konto deaktiviert' } };
        
        // Lizenz prüfen für Nicht-Admins
        if (user.role !== 'admin') {
            const lic = db.get('license');
            if (!lic?.activation_id) return { status: 403, body: { error: 'Keine Lizenz auf diesem Server aktiviert' } };
        }
        
        const token = createSession(user.id, device_type);
        return { status: 200, body: { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } } };
    },
    
    'POST /api/auth/logout': async (req, body, auth) => {
        if (!auth) return { status: 401, body: { error: 'Nicht angemeldet' } };
        db.delete('sessions', auth.session.id);
        return { status: 200, body: { success: true } };
    },
    
    'GET /api/auth/me': async (req, body, auth) => {
        if (!auth) return { status: 401, body: { error: 'Nicht angemeldet' } };
        return { status: 200, body: { user: { id: auth.user.id, email: auth.user.email, name: auth.user.name, role: auth.user.role } } };
    },
    
    // License
    'POST /api/license/activate': async (req, body, auth) => {
        if (!auth || auth.user.role !== 'admin') return { status: 403, body: { error: 'Admin erforderlich' } };
        const { license_key } = body;
        if (!license_key) return { status: 400, body: { error: 'Lizenzschlüssel erforderlich' } };
        
        try {
            const result = await callLicenseServer('/activate', 'POST', {
                license_key: license_key.toUpperCase(),
                server_id: SERVER_ID,
                server_name: process.env.SERVER_NAME || 'Dictation Server'
            });
            
            db.set('license', {
                activation_id: result.activation.id,
                key: license_key.toUpperCase(),
                max_concurrent_users: result.activation.max_concurrent_users,
                max_devices: result.activation.max_devices,
                expires_at: result.activation.expires_at,
                activated_at: new Date().toISOString()
            });
            
            console.log('✓ License activated:', result.activation.id);
            return { status: 200, body: { success: true, license: db.get('license') } };
        } catch (e) {
            return { status: 400, body: { error: e.message } };
        }
    },
    
    'GET /api/license': async (req, body, auth) => {
        if (!auth || auth.user.role !== 'admin') return { status: 403, body: { error: 'Admin erforderlich' } };
        const lic = db.get('license');
        if (!lic) return { status: 200, body: { license: null } };
        return { status: 200, body: { license: { ...lic, current_users: getConnectedUserCount(), current_devices: getConnectedDeviceCount() } } };
    },
    
    'POST /api/license/validate': async (req, body, auth) => {
        if (!auth || auth.user.role !== 'admin') return { status: 403, body: { error: 'Admin erforderlich' } };
        const lic = db.get('license');
        if (!lic?.activation_id) return { status: 400, body: { error: 'Keine Lizenz aktiviert' } };
        
        try {
            const result = await callLicenseServer('/validate', 'POST', { activation_id: lic.activation_id, server_id: SERVER_ID });
            lic.expires_at = result.expires_at;
            lic.max_concurrent_users = result.max_concurrent_users;
            lic.max_devices = result.max_devices;
            db.set('license', lic);
            return { status: 200, body: { valid: true, license: lic } };
        } catch (e) {
            return { status: 400, body: { valid: false, error: e.message } };
        }
    },
    
    'POST /api/license/deactivate': async (req, body, auth) => {
        if (!auth || auth.user.role !== 'admin') return { status: 403, body: { error: 'Admin erforderlich' } };
        const lic = db.get('license');
        if (!lic?.activation_id) return { status: 400, body: { error: 'Keine Lizenz aktiviert' } };
        
        try {
            await callLicenseServer('/deactivate', 'POST', { activation_id: lic.activation_id, server_id: SERVER_ID });
        } catch {}
        
        db.set('license', null);
        
        // Alle trennen
        for (const [uid, conns] of activeUsers) {
            if (conns.mobile) conns.mobile.close(4001, 'License deactivated');
            if (conns.desktop) conns.desktop.close(4001, 'License deactivated');
        }
        activeUsers.clear();
        
        return { status: 200, body: { success: true } };
    },
    
    // Users
    'GET /api/users': async (req, body, auth) => {
        if (!auth || auth.user.role !== 'admin') return { status: 403, body: { error: 'Admin erforderlich' } };
        const users = db.findAll('users').map(u => {
            const online = activeUsers.get(u.id);
            return {
                id: u.id, email: u.email, name: u.name, role: u.role, is_active: u.is_active, created_at: u.created_at,
                is_online: !!online,
                devices_connected: online ? [online.mobile && 'mobile', online.desktop && 'desktop'].filter(Boolean) : []
            };
        });
        return { status: 200, body: { users } };
    },
    
    'POST /api/users': async (req, body, auth) => {
        if (!auth || auth.user.role !== 'admin') return { status: 403, body: { error: 'Admin erforderlich' } };
        const { email, password, name, role } = body;
        if (!email || !password || !name) return { status: 400, body: { error: 'E-Mail, Passwort und Name erforderlich' } };
        if (password.length < 6) return { status: 400, body: { error: 'Passwort min. 6 Zeichen' } };
        if (db.findOne('users', u => u.email.toLowerCase() === email.toLowerCase())) return { status: 409, body: { error: 'E-Mail existiert bereits' } };
        
        const user = db.insert('users', { email: email.toLowerCase(), password_hash: hash(password), name, role: role || 'user', is_active: true });
        return { status: 201, body: { user: { id: user.id, email: user.email, name: user.name, role: user.role } } };
    },
    
    'PUT /api/users/:id': async (req, body, auth, params) => {
        if (!auth || auth.user.role !== 'admin') return { status: 403, body: { error: 'Admin erforderlich' } };
        const user = db.find('users', params.id);
        if (!user) return { status: 404, body: { error: 'Benutzer nicht gefunden' } };
        
        const updates = {};
        if (body.name) updates.name = body.name;
        if (body.role) updates.role = body.role;
        if (typeof body.is_active === 'boolean') updates.is_active = body.is_active;
        if (body.password?.length >= 6) updates.password_hash = hash(body.password);
        
        db.update('users', params.id, updates);
        
        // Trennen wenn deaktiviert
        if (body.is_active === false && activeUsers.has(params.id)) {
            const c = activeUsers.get(params.id);
            if (c.mobile) c.mobile.close(4002, 'Account deactivated');
            if (c.desktop) c.desktop.close(4002, 'Account deactivated');
            activeUsers.delete(params.id);
        }
        
        return { status: 200, body: { success: true } };
    },
    
    'DELETE /api/users/:id': async (req, body, auth, params) => {
        if (!auth || auth.user.role !== 'admin') return { status: 403, body: { error: 'Admin erforderlich' } };
        if (params.id === auth.user.id) return { status: 400, body: { error: 'Kann sich nicht selbst löschen' } };
        
        if (activeUsers.has(params.id)) {
            const c = activeUsers.get(params.id);
            if (c.mobile) c.mobile.close(4003, 'Account deleted');
            if (c.desktop) c.desktop.close(4003, 'Account deleted');
            activeUsers.delete(params.id);
        }
        
        db.findAll('sessions', s => s.user_id === params.id).forEach(s => db.delete('sessions', s.id));
        db.delete('users', params.id);
        return { status: 200, body: { success: true } };
    },
    
    // Stats
    'GET /api/stats': async (req, body, auth) => {
        if (!auth || auth.user.role !== 'admin') return { status: 403, body: { error: 'Admin erforderlich' } };
        const lic = db.get('license');
        return {
            status: 200,
            body: {
                total_users: db.count('users'),
                active_users: db.count('users', u => u.is_active),
                connected_users: getConnectedUserCount(),
                connected_devices: getConnectedDeviceCount(),
                license: lic ? { max_concurrent_users: lic.max_concurrent_users, max_devices: lic.max_devices, expires_at: lic.expires_at } : null
            }
        };
    }
};

// ============================================================================
// HTTP Server
// ============================================================================
function matchRoute(method, pathname) {
    for (const [key, handler] of Object.entries(routes)) {
        const [m, p] = key.split(' ');
        if (m !== method) continue;
        const rp = p.split('/'), pp = pathname.split('/');
        if (rp.length !== pp.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < rp.length; i++) {
            if (rp[i].startsWith(':')) params[rp[i].slice(1)] = pp[i];
            else if (rp[i] !== pp[i]) { ok = false; break; }
        }
        if (ok) return { handler, params };
    }
    return null;
}

async function handleHttp(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    
    const pathname = url.parse(req.url).pathname;
    const route = matchRoute(req.method, pathname);
    if (!route) { res.writeHead(404, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Not found'})); return; }
    
    let body = {};
    if (['POST','PUT','PATCH'].includes(req.method)) {
        try {
            const raw = await new Promise((res, rej) => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>res(d)); req.on('error',rej); });
            body = raw ? JSON.parse(raw) : {};
        } catch { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Invalid JSON'})); return; }
    }
    
    let auth = null;
    const ah = req.headers.authorization;
    if (ah?.startsWith('Bearer ')) auth = validateSession(ah.slice(7));
    
    try {
        const result = await route.handler(req, body, auth, route.params);
        res.writeHead(result.status, {'Content-Type':'application/json'});
        res.end(JSON.stringify(result.body));
    } catch (e) {
        console.error('Error:', e);
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'Server error'}));
    }
}

// ============================================================================
// WebSocket
// ============================================================================
function setupWS(server) {
    const wss = new WebSocketServer({ server });
    
    wss.on('connection', ws => {
        let userId = null, deviceType = null, userName = null;
        
        ws.on('message', data => {
            try {
                const msg = JSON.parse(data.toString());
                
                if (msg.type === 'auth') {
                    const auth = validateSession(msg.token);
                    if (!auth) { ws.send(JSON.stringify({type:'error',error:'Ungültige Session'})); ws.close(); return; }
                    if (!['mobile','desktop'].includes(msg.device_type)) { ws.send(JSON.stringify({type:'error',error:'Ungültiger Gerätetyp'})); ws.close(); return; }
                    
                    const check = canUserConnect(auth.user.id, msg.device_type);
                    if (!check.ok) { ws.send(JSON.stringify({type:'error',error:check.error})); ws.close(); return; }
                    
                    userId = auth.user.id;
                    deviceType = msg.device_type;
                    userName = auth.user.name;
                    
                    registerConnection(userId, deviceType, ws, userName);
                    ws.send(JSON.stringify({ type: 'authenticated', user: { id: userId, name: userName }, paired: isPaired(userId) }));
                    console.log(`Connected: ${userName} (${deviceType}) - ${getConnectedUserCount()} users online`);
                }
                
                else if (msg.type === 'dictation' && deviceType === 'mobile') {
                    const partner = getPartner(userId, deviceType);
                    if (partner?.readyState === 1) partner.send(JSON.stringify({ type: 'dictation', text: msg.text, isFinal: msg.isFinal }));
                }
                
                else if (msg.type === 'command' && deviceType === 'mobile') {
                    const partner = getPartner(userId, deviceType);
                    if (partner?.readyState === 1) partner.send(JSON.stringify({ type: 'command', command: msg.command }));
                }
                
                else if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
                
            } catch (e) { console.error('WS error:', e); }
        });
        
        ws.on('close', () => {
            if (userId) {
                unregisterConnection(userId, deviceType);
                console.log(`Disconnected: ${userName} (${deviceType}) - ${getConnectedUserCount()} users online`);
            }
        });
    });
}

// ============================================================================
// Start
// ============================================================================
init();
const server = http.createServer(handleHttp);
setupWS(server);
server.listen(PORT, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║         DICTATION SERVER v3 - Auto-Pairing                ║');
    console.log('╠═══════════════════════════════════════════════════════════╣');
    console.log(`║  HTTP:      http://localhost:${PORT}/api                     ║`);
    console.log(`║  WebSocket: ws://localhost:${PORT}                           ║`);
    console.log(`║  Server-ID: ${SERVER_ID}                              ║`);
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
});
