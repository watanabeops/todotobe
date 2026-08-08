/* TODOTOBE の Service Worker
 *
 * ネットワークを先に見て、失敗したときだけキャッシュを出す。
 * 逆（キャッシュ優先）にすると、直したはずの古いファイルが配られ続ける。
 */

const CACHE = 'todotobe-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icons/favicon-64.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const req = e.request;
    if (req.method !== 'GET') return;
    if (new URL(req.url).origin !== location.origin) return;   // FirestoreへはSWを挟まない

    e.respondWith(
        fetch(req)
            .then(res => {
                const copy = res.clone();
                caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
                return res;
            })
            .catch(() => caches.match(req).then(hit => hit || caches.match('index.html')))
    );
});
