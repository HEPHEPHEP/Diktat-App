<?php
/**
 * Dictation License Server
 * 
 * Verwaltet Lizenzen, Aktivierungen und Validierungen.
 * Wird vom Hauptserver kontaktiert.
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// Config
define('DATA_DIR', __DIR__ . '/data');
define('API_SECRET', getenv('LICENSE_API_SECRET') ?: 'license-server-secret-key');

if (!file_exists(DATA_DIR)) mkdir(DATA_DIR, 0755, true);

// Database
function loadData($file) {
    $path = DATA_DIR . '/' . $file . '.json';
    return file_exists($path) ? json_decode(file_get_contents($path), true) : [];
}

function saveData($file, $data) {
    file_put_contents(DATA_DIR . '/' . $file . '.json', json_encode($data, JSON_PRETTY_PRINT));
}

function generateKey() {
    $parts = [];
    for ($i = 0; $i < 4; $i++) $parts[] = strtoupper(bin2hex(random_bytes(2)));
    return implode('-', $parts);
}

function response($data, $status = 200) {
    http_response_code($status);
    echo json_encode($data);
    exit;
}

// Auth check
function checkAuth() {
    $headers = getallheaders();
    $auth = $headers['Authorization'] ?? $headers['authorization'] ?? '';
    if (strpos($auth, 'Bearer ') === 0 && substr($auth, 7) === API_SECRET) return true;
    response(['error' => 'Unauthorized'], 401);
}

// Routing
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$uri = preg_replace('#^/api\.php#', '', $uri);
$method = $_SERVER['REQUEST_METHOD'];
$body = json_decode(file_get_contents('php://input'), true) ?: [];

// Health
if ($uri === '/health') response(['status' => 'ok']);

checkAuth();

// === LICENSES ===

// List licenses
if ($uri === '/licenses' && $method === 'GET') {
    $licenses = loadData('licenses');
    response(['licenses' => array_values($licenses)]);
}

// Create license
if ($uri === '/licenses' && $method === 'POST') {
    $licenses = loadData('licenses');
    
    $license = [
        'id' => uniqid('lic_'),
        'key' => $body['key'] ?? generateKey(),
        'name' => $body['name'] ?? 'License',
        'max_concurrent_users' => intval($body['max_concurrent_users'] ?? 5),
        'max_devices' => intval($body['max_devices'] ?? 5),
        'valid_days' => intval($body['valid_days'] ?? 365),
        'created_at' => date('c'),
        'status' => 'available'
    ];
    
    // Check duplicate
    foreach ($licenses as $l) {
        if ($l['key'] === $license['key']) response(['error' => 'Key exists'], 409);
    }
    
    $licenses[$license['id']] = $license;
    saveData('licenses', $licenses);
    response(['license' => $license], 201);
}

// Get license
if (preg_match('#^/licenses/([^/]+)$#', $uri, $m) && $method === 'GET') {
    $licenses = loadData('licenses');
    if (!isset($licenses[$m[1]])) response(['error' => 'Not found'], 404);
    response(['license' => $licenses[$m[1]]]);
}

// Update license
if (preg_match('#^/licenses/([^/]+)$#', $uri, $m) && $method === 'PUT') {
    $licenses = loadData('licenses');
    if (!isset($licenses[$m[1]])) response(['error' => 'Not found'], 404);
    
    $lic = $licenses[$m[1]];
    if (isset($body['name'])) $lic['name'] = $body['name'];
    if (isset($body['max_concurrent_users'])) $lic['max_concurrent_users'] = intval($body['max_concurrent_users']);
    if (isset($body['max_devices'])) $lic['max_devices'] = intval($body['max_devices']);
    if (isset($body['status'])) $lic['status'] = $body['status'];
    $lic['updated_at'] = date('c');
    
    $licenses[$m[1]] = $lic;
    saveData('licenses', $licenses);
    response(['license' => $lic]);
}

// Delete license
if (preg_match('#^/licenses/([^/]+)$#', $uri, $m) && $method === 'DELETE') {
    $licenses = loadData('licenses');
    if (!isset($licenses[$m[1]])) response(['error' => 'Not found'], 404);
    
    $activations = loadData('activations');
    foreach ($activations as $a) {
        if ($a['license_id'] === $m[1] && $a['status'] === 'active') {
            response(['error' => 'License is activated'], 400);
        }
    }
    
    unset($licenses[$m[1]]);
    saveData('licenses', $licenses);
    response(['success' => true]);
}

// === ACTIVATION ===

// Activate license
if ($uri === '/activate' && $method === 'POST') {
    $key = strtoupper(trim($body['license_key'] ?? ''));
    $serverId = $body['server_id'] ?? '';
    $serverName = $body['server_name'] ?? 'Server';
    
    if (!$key) response(['error' => 'License key required'], 400);
    if (!$serverId) response(['error' => 'Server ID required'], 400);
    
    $licenses = loadData('licenses');
    $license = null;
    $licenseId = null;
    
    foreach ($licenses as $id => $l) {
        if ($l['key'] === $key) {
            $license = $l;
            $licenseId = $id;
            break;
        }
    }
    
    if (!$license) response(['error' => 'Invalid license key'], 404);
    if ($license['status'] === 'revoked') response(['error' => 'License revoked'], 403);
    
    // Check if already activated elsewhere
    $activations = loadData('activations');
    foreach ($activations as $a) {
        if ($a['license_id'] === $licenseId && $a['status'] === 'active' && $a['server_id'] !== $serverId) {
            response(['error' => 'License activated on another server: ' . $a['server_name']], 403);
        }
    }
    
    // Find or create activation
    $activationId = null;
    foreach ($activations as $id => $a) {
        if ($a['license_id'] === $licenseId && $a['server_id'] === $serverId) {
            $activationId = $id;
            break;
        }
    }
    
    $expiresAt = date('c', strtotime('+' . $license['valid_days'] . ' days'));
    
    $activation = [
        'id' => $activationId ?? uniqid('act_'),
        'license_id' => $licenseId,
        'license_key' => $key,
        'server_id' => $serverId,
        'server_name' => $serverName,
        'activated_at' => $activationId ? ($activations[$activationId]['activated_at'] ?? date('c')) : date('c'),
        'expires_at' => $expiresAt,
        'status' => 'active',
        'max_concurrent_users' => $license['max_concurrent_users'],
        'max_devices' => $license['max_devices']
    ];
    
    $activations[$activation['id']] = $activation;
    saveData('activations', $activations);
    
    $licenses[$licenseId]['status'] = 'activated';
    saveData('licenses', $licenses);
    
    response([
        'success' => true,
        'activation' => [
            'id' => $activation['id'],
            'expires_at' => $activation['expires_at'],
            'max_concurrent_users' => $activation['max_concurrent_users'],
            'max_devices' => $activation['max_devices']
        ]
    ]);
}

// Validate activation
if ($uri === '/validate' && $method === 'POST') {
    $activationId = $body['activation_id'] ?? '';
    $serverId = $body['server_id'] ?? '';
    
    if (!$activationId || !$serverId) response(['error' => 'Missing parameters'], 400);
    
    $activations = loadData('activations');
    if (!isset($activations[$activationId])) response(['valid' => false, 'error' => 'Activation not found'], 404);
    
    $a = $activations[$activationId];
    
    if ($a['server_id'] !== $serverId) response(['valid' => false, 'error' => 'Server mismatch'], 403);
    if (strtotime($a['expires_at']) < time()) {
        $a['status'] = 'expired';
        $activations[$activationId] = $a;
        saveData('activations', $activations);
        response(['valid' => false, 'error' => 'License expired'], 403);
    }
    if ($a['status'] !== 'active') response(['valid' => false, 'error' => 'License not active'], 403);
    
    response([
        'valid' => true,
        'expires_at' => $a['expires_at'],
        'max_concurrent_users' => $a['max_concurrent_users'],
        'max_devices' => $a['max_devices']
    ]);
}

// Deactivate
if ($uri === '/deactivate' && $method === 'POST') {
    $activationId = $body['activation_id'] ?? '';
    $serverId = $body['server_id'] ?? '';
    
    $activations = loadData('activations');
    if (!isset($activations[$activationId])) response(['error' => 'Not found'], 404);
    
    $a = $activations[$activationId];
    if ($a['server_id'] !== $serverId) response(['error' => 'Server mismatch'], 403);
    
    $a['status'] = 'deactivated';
    $a['deactivated_at'] = date('c');
    $activations[$activationId] = $a;
    saveData('activations', $activations);
    
    $licenses = loadData('licenses');
    if (isset($licenses[$a['license_id']])) {
        $licenses[$a['license_id']]['status'] = 'available';
        saveData('licenses', $licenses);
    }
    
    response(['success' => true]);
}

// List activations
if ($uri === '/activations' && $method === 'GET') {
    response(['activations' => array_values(loadData('activations'))]);
}

// Stats
if ($uri === '/stats' && $method === 'GET') {
    $licenses = loadData('licenses');
    $activations = loadData('activations');
    
    $stats = ['total' => count($licenses), 'available' => 0, 'activated' => 0, 'active_activations' => 0];
    foreach ($licenses as $l) {
        if ($l['status'] === 'available') $stats['available']++;
        if ($l['status'] === 'activated') $stats['activated']++;
    }
    foreach ($activations as $a) {
        if ($a['status'] === 'active') $stats['active_activations']++;
    }
    response($stats);
}

response(['error' => 'Not found'], 404);
