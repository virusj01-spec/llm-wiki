const CACHE_NAME = 'llm-wiki-v11';

// Install — 오프라인 폴백용 최소 캐시만 저장
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll([
      './index.html',
      './css/app.css',
    ]))
  );
  self.skipWaiting();
});

// Activate — 이전 버전 캐시 전체 삭제
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — Network First 전략
// JS/CSS/HTML은 항상 네트워크에서 최신 버전을 먼저 가져옴
// 오프라인일 때만 캐시 폴백
self.addEventListener('fetch', (e) => {
  // API 호출은 SW가 관여하지 않음
  if (e.request.url.includes('googleapis.com')) return;
  if (e.request.url.includes('github.com')) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // 성공하면 캐시도 업데이트 (다음 오프라인 접속 대비)
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return res;
      })
      .catch(() => {
        // 네트워크 실패 시 캐시 폴백
        return caches.match(e.request).then(cached => {
          return cached || caches.match('./index.html');
        });
      })
  );
});
