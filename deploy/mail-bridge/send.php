<?php
/**
 * StockSense mail bridge.
 *
 * Some hosts (Render's free tier, for one) block outgoing SMTP ports. This endpoint
 * runs on ordinary web hosting, accepts one email over HTTPS and hands it to an SMTP
 * server over implicit TLS (port 465).
 *
 * It stores no secrets: the caller sends the SMTP login with each request, and the
 * SMTP server decides whether it is valid, so the bridge cannot be used by anyone
 * who does not already hold a mailbox password. Only whitelisted SMTP hosts are used.
 *
 * POST application/json:
 *   { "host", "user", "pass", "from", "fromName", "to", "subject", "text", "html" }
 */
declare(strict_types=1);
header('Content-Type: application/json');
header('Cache-Control: no-store');

const ALLOWED_HOSTS = ['smtp.hostinger.com'];

function reply(int $status, array $body): void {
    http_response_code($status);
    echo json_encode($body);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') reply(405, ['error' => 'POST only']);
if (($_SERVER['HTTPS'] ?? '') !== 'on' && ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') !== 'https') reply(400, ['error' => 'HTTPS only']);

$in = json_decode(file_get_contents('php://input', false, null, 0, 512 * 1024) ?: '', true);
if (!is_array($in)) reply(400, ['error' => 'Invalid JSON']);

$host = (string)($in['host'] ?? '');
$user = (string)($in['user'] ?? '');
$pass = (string)($in['pass'] ?? '');
$from = (string)($in['from'] ?? '');
$fromName = (string)($in['fromName'] ?? 'StockSense');
$to = (string)($in['to'] ?? '');
$subject = (string)($in['subject'] ?? '');
$text = (string)($in['text'] ?? '');
$html = (string)($in['html'] ?? '');

if (!in_array($host, ALLOWED_HOSTS, true)) reply(400, ['error' => 'SMTP host not allowed']);
foreach ([$from, $to] as $addr) {
    if (!filter_var($addr, FILTER_VALIDATE_EMAIL)) reply(400, ['error' => 'Invalid address']);
}
// no header injection through any single-line field
foreach ([$user, $from, $fromName, $to, $subject] as $v) {
    if (preg_match('/[\r\n]/', $v)) reply(400, ['error' => 'Invalid header value']);
}
if ($user === '' || $pass === '' || $subject === '' || ($text === '' && $html === '')) reply(400, ['error' => 'Missing fields']);

$sock = @stream_socket_client("ssl://$host:465", $errno, $errstr, 15, STREAM_CLIENT_CONNECT,
    stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]));
if (!$sock) reply(502, ['error' => "Cannot reach SMTP server: $errstr"]);
stream_set_timeout($sock, 20);

function expect($sock, array $codes): string {
    $data = '';
    while (($line = fgets($sock, 1024)) !== false) {
        $data .= $line;
        if (strlen($line) < 4 || $line[3] !== '-') break;
    }
    $code = (int)substr($data, 0, 3);
    if (!in_array($code, $codes, true)) {
        reply(502, ['error' => 'SMTP rejected the message', 'smtp' => trim(substr($data, 0, 200))]);
    }
    return $data;
}
function cmd($sock, string $line, array $codes): string {
    fwrite($sock, $line . "\r\n");
    return expect($sock, $codes);
}

expect($sock, [220]);
cmd($sock, 'EHLO ' . ($_SERVER['SERVER_NAME'] ?? 'localhost'), [250]);
cmd($sock, 'AUTH LOGIN', [334]);
cmd($sock, base64_encode($user), [334]);
cmd($sock, base64_encode($pass), [235]);
cmd($sock, "MAIL FROM:<$from>", [250]);
cmd($sock, "RCPT TO:<$to>", [250, 251]);
cmd($sock, 'DATA', [354]);

$boundary = 'ss-' . bin2hex(random_bytes(12));
$encName = '=?UTF-8?B?' . base64_encode($fromName) . '?=';
$encSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';
$domain = substr(strrchr($from, '@'), 1);
$headers = [
    "From: $encName <$from>",
    "To: <$to>",
    "Subject: $encSubject",
    'Date: ' . date(DATE_RFC2822),
    'Message-ID: <' . bin2hex(random_bytes(16)) . "@$domain>",
    'MIME-Version: 1.0',
    "Content-Type: multipart/alternative; boundary=\"$boundary\"",
];
$part = fn(string $type, string $body) => "--$boundary\r\nContent-Type: $type; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
    . chunk_split(base64_encode($body), 76, "\r\n");
$message = implode("\r\n", $headers) . "\r\n\r\n"
    . ($text !== '' ? $part('text/plain', $text) : '')
    . ($html !== '' ? $part('text/html', $html) : '')
    . "--$boundary--\r\n";
// base64 bodies never contain a lone "." line, so no dot-stuffing is needed
fwrite($sock, $message . "\r\n.\r\n");
$accepted = expect($sock, [250]);
cmd($sock, 'QUIT', [221, 250]);
fclose($sock);

reply(200, ['ok' => true, 'smtp' => trim(substr($accepted, 0, 120))]);
