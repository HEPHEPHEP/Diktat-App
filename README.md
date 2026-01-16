# 🎤 Dictation App v3

Sprache-zu-Text System mit zentraler Lizenzierung und automatischem Pairing.

## 📋 Workflow

```
1. Admin kauft Lizenz (z.B. 5 Benutzer, 5 Geräte gleichzeitig)
         ↓
2. Admin importiert Lizenzschlüssel ins System
         ↓
   Server aktiviert Lizenz gegen PHP-Lizenzserver
         ↓
3. Admin legt Benutzer an (beliebig viele, z.B. 10)
         ↓
4. Benutzer melden sich an:
   - Mobile-App: Login mit E-Mail/Passwort
   - Desktop-App: Login mit DEMSELBEN Konto
         ↓
   → Automatisches Pairing! (kein Code nötig)
         ↓
5. Von 10 Benutzern können nur 5 gleichzeitig verbunden sein
```

## 🏗️ Architektur

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  📱 Mobile App  │     │  💻 Desktop App │     │  🔧 Admin Tool  │
│  (PWA)          │     │  (Electron)     │     │  (Web)          │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │ WebSocket + REST
                    ┌────────────▼────────────┐
                    │   🖥️ Dictation Server   │
                    │   - Auth & Sessions     │
                    │   - User Management     │
                    │   - Concurrent Limits   │
                    │   - Auto-Pairing        │
                    └────────────┬────────────┘
                                 │ HTTP
                    ┌────────────▼────────────┐
                    │   🔑 License Server     │
                    │   - License Activation  │
                    │   - Validation          │
                    │   - Limits Enforcement  │
                    └─────────────────────────┘
```

## 🚀 Schnellstart

### 1. System starten

```bash
cd dictation-app
docker-compose up -d
```

### 2. Lizenz erstellen (im Lizenzserver)

```bash
# Neue Lizenz erstellen (5 User, 5 Geräte gleichzeitig)
curl -X POST http://localhost:8083/api.php/licenses \
  -H "Authorization: Bearer license-server-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Firma XY",
    "max_concurrent_users": 5,
    "max_concurrent_devices": 5,
    "valid_days": 365
  }'
```

Notieren Sie den generierten `key` (z.B. `A1B2-C3D4-E5F6-G7H8`).

### 3. Lizenz aktivieren

1. Admin-Tool öffnen: http://localhost:8082
2. Anmelden: `admin@localhost` / `admin123`
3. "Lizenz" → Lizenzschlüssel eingeben → "Aktivieren"

### 4. Benutzer anlegen

1. Im Admin-Tool: "Benutzer" → "Neuer Benutzer"
2. E-Mail, Passwort, Name vergeben
3. Beliebig viele Benutzer anlegen

### 5. Desktop-App starten

```bash
cd desktop-app
npm install
npm start
```

Mit Benutzerkonto anmelden.

### 6. Mobile-App nutzen

1. http://localhost:8081 öffnen
2. Mit DEMSELBEN Konto anmelden
3. → Automatisch verbunden!
4. Diktieren starten

## 📦 Ports

| Dienst | Port | Beschreibung |
|--------|------|--------------|
| Server | 8080 | API + WebSocket |
| Mobile-App | 8081 | PWA |
| Admin-Tool | 8082 | Verwaltung |
| License-Server | 8083 | Lizenz-API |

## 🔑 Lizenzierung

### Limits

| Limit | Beschreibung |
|-------|--------------|
| `max_concurrent_users` | Wie viele Benutzer gleichzeitig verbunden sein können |
| `max_concurrent_devices` | Wie viele Geräte (Mobile+Desktop) gleichzeitig verbunden sein können |
| `max_total_users` | Max. Benutzer insgesamt (0 = unbegrenzt) |
| `valid_days` | Gültigkeitsdauer ab Aktivierung |

### Beispiel

Lizenz: 5 User, 10 Geräte
- Admin legt 20 Benutzer an ✓
- 5 Benutzer können sich gleichzeitig verbinden ✓
- Jeder mit Mobile + Desktop = 10 Geräte ✓
- 6. Benutzer versucht sich zu verbinden → "Max erreicht" ✗

### Lizenz-API Endpunkte

```bash
# Lizenz erstellen
POST /api.php/licenses
{
  "name": "License Name",
  "max_concurrent_users": 5,
  "max_concurrent_devices": 10,
  "max_total_users": 0,
  "valid_days": 365
}

# Alle Lizenzen auflisten
GET /api.php/licenses

# Lizenz aktivieren (vom Server aufgerufen)
POST /api.php/activate
{
  "license_key": "XXXX-XXXX-XXXX-XXXX",
  "server_id": "server-001",
  "server_name": "My Server"
}

# Lizenz validieren
POST /api.php/validate
{
  "activation_id": "act_xxx",
  "server_id": "server-001"
}
```

## 🔄 Auto-Pairing

**Kein manueller Pairing-Code mehr nötig!**

Das System erkennt automatisch, wenn sich ein Benutzer mit demselben Konto auf Mobile UND Desktop anmeldet und verbindet beide Geräte.

```
Benutzer meldet sich an auf Mobile → Wartet auf Desktop
Benutzer meldet sich an auf Desktop → Automatisch verbunden!
```

## 📡 API-Endpunkte (Server)

### Auth
| Methode | Endpoint | Beschreibung |
|---------|----------|--------------|
| POST | /api/auth/login | Anmelden (device_type: mobile/desktop) |
| POST | /api/auth/logout | Abmelden |
| GET | /api/auth/me | Benutzerinfo |

### Lizenz (Admin)
| Methode | Endpoint | Beschreibung |
|---------|----------|--------------|
| GET | /api/license | Lizenzinfo |
| POST | /api/license/activate | Lizenz aktivieren |
| POST | /api/license/validate | Lizenz prüfen |
| POST | /api/license/deactivate | Lizenz deaktivieren |

### Benutzer (Admin)
| Methode | Endpoint | Beschreibung |
|---------|----------|--------------|
| GET | /api/users | Alle Benutzer |
| POST | /api/users | Benutzer erstellen |
| PUT | /api/users/:id | Benutzer bearbeiten |
| DELETE | /api/users/:id | Benutzer löschen |

### Stats (Admin)
| Methode | Endpoint | Beschreibung |
|---------|----------|--------------|
| GET | /api/stats | System-Statistiken |

## 🔌 WebSocket-Protokoll

### Verbindung

```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.send(JSON.stringify({
    type: 'auth',
    token: 'session-token',
    device_type: 'mobile' // oder 'desktop'
}));
```

### Nachrichten

| Von | Type | Beschreibung |
|-----|------|--------------|
| Client | `auth` | Authentifizierung |
| Server | `authenticated` | Erfolgreich (inkl. `paired: true/false`) |
| Server | `paired` | Partner verbunden |
| Server | `partner_disconnected` | Partner getrennt |
| Mobile | `dictation` | Text senden `{text, isFinal}` |
| Mobile | `command` | Befehl senden `{command}` |
| Server | `error` | Fehlermeldung |

## 📁 Projektstruktur

```
dictation-app/
├── server/                 # Node.js Backend
│   ├── server.js          # API + WebSocket + Auto-Pairing
│   ├── package.json
│   └── Dockerfile
├── license-server/         # PHP Lizenzserver
│   └── api.php            # Lizenz-API
├── admin-tool/            # Admin-Webanwendung
│   └── index.html
├── mobile-app/            # Mobile PWA
│   ├── index.html
│   └── manifest.json
├── desktop-app/           # Electron App
│   ├── main.js
│   ├── package.json
│   └── renderer/
│       ├── index.html
│       └── text-window.html
├── docker-compose.yml
├── nginx-mobile.conf
└── README.md
```

## ⚙️ Umgebungsvariablen

```bash
# Server
JWT_SECRET=your-secret-key
ADMIN_PASSWORD=admin123
LICENSE_SERVER_URL=http://license-server/api.php
LICENSE_SERVER_SECRET=license-server-secret-key
SERVER_ID=server-001

# License Server
LICENSE_API_SECRET=license-server-secret-key
```

## 🔒 Sicherheit

Für Produktion:
1. Alle Secrets ändern
2. HTTPS aktivieren (Spracherkennung benötigt HTTPS)
3. LICENSE_API_SECRET komplex wählen
4. Firewall: Lizenzserver nur intern erreichbar machen

## ❓ FAQ

**Warum kann ich mich nicht verbinden?**
- Lizenz aktiviert? (Admin-Tool → Lizenz)
- Gleichzeitiges Limit erreicht? (Dashboard prüfen)
- Benutzer aktiv? (Admin-Tool → Benutzer)

**Warum wird mein Partner nicht verbunden?**
- Beide mit DEMSELBEN Konto anmelden
- Einer Mobile, einer Desktop

**Spracherkennung funktioniert nicht?**
- HTTPS erforderlich (außer localhost)
- Mikrofon-Berechtigung erteilen
- Chrome/Edge verwenden

## 📄 Lizenz

MIT License
