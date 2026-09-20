#!/usr/bin/env python3
"""屋根提案シート デモサーバー(Python 標準ライブラリのみ)

- APIキーは環境変数 / .env から読む。リポジトリには置かない。
    GOOGLE_MAPS_SERVER_KEY   Solar / Geocoding / Static Maps 用(ブラウザに渡さない)
    GOOGLE_MAPS_BROWSER_KEY  Maps JavaScript API 用(HTML に注入。リファラ制限必須)
    GOOGLE_MAPS_API_KEY      上記2つを兼ねる場合の1本キー(省略可)
    MOCK_SOLAR=1             Solar API を呼ばず疑似データを返す(UI確認用)
    SOLAR_DAILY_LIMIT        Solar API の1日上限(既定 100)。超えたら Google に送らず 429 を返す
    GEOCODE_DAILY_LIMIT      Geocoding の1日上限(既定 100)
    STATICMAP_DAILY_LIMIT    Static Maps の1日上限(既定 200)
    PORT                     既定 5194
- /api/* はサーバーがキーを付けて Google に中継し、結果を data/cache に保存(同じ建物の再クリックは無料)
"""
import os, sys, json, hashlib, gzip, random, math, urllib.request, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB, DATA, CACHE = os.path.join(ROOT,'web'), os.path.join(ROOT,'data'), os.path.join(ROOT,'data','cache')

def load_env():
    p = os.path.join(ROOT, '.env')
    if os.path.exists(p):
        for line in open(p, encoding='utf-8'):
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line: continue
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
load_env()
SERVER_KEY  = os.environ.get('GOOGLE_MAPS_SERVER_KEY')  or os.environ.get('GOOGLE_MAPS_API_KEY', '')
BROWSER_KEY = os.environ.get('GOOGLE_MAPS_BROWSER_KEY') or os.environ.get('GOOGLE_MAPS_API_KEY', '')
MOCK = os.environ.get('MOCK_SOLAR') == '1' or not SERVER_KEY
PORT = int(os.environ.get('PORT', '5194'))
LIMITS = {'solar': int(os.environ.get('SOLAR_DAILY_LIMIT', '100')), 'geocode': int(os.environ.get('GEOCODE_DAILY_LIMIT', '100')),
          'staticmap': int(os.environ.get('STATICMAP_DAILY_LIMIT', '200'))}
USAGE_FILE = os.path.join(CACHE, 'usage.json')
SOLAR_CACHE_DAYS = 30

def purge_solar_cache():
    """起動時に30日を超えた Solar キャッシュを削除(規約20.2)"""
    import time
    d = os.path.join(CACHE, 'solar')
    if not os.path.isdir(d): return
    for f in os.listdir(d):
        fp = os.path.join(d, f)
        if time.time() - os.path.getmtime(fp) > SOLAR_CACHE_DAYS * 86400: os.remove(fp)
import threading, datetime
_usage_lock = threading.Lock()

def usage_today():
    day = datetime.date.today().isoformat()
    try: u = json.load(open(USAGE_FILE))
    except Exception: u = {}
    if u.get('day') != day: u = {'day': day}
    return u

def usage_take(kind):
    """1日上限の消費。上限内なら True(カウント+1)、超過なら False"""
    with _usage_lock:
        u = usage_today(); n = u.get(kind, 0)
        if n >= LIMITS[kind]: return False
        u[kind] = n + 1
        os.makedirs(CACHE, exist_ok=True); json.dump(u, open(USAGE_FILE, 'w'))
        return True

def limit_error(kind):
    return {'error': {'code': 429, 'message': f'本日の {kind} 呼び出し上限({LIMITS[kind]}回)に達しました。明日リセットされます(.env の *_DAILY_LIMIT で変更可)'}}

MIME = {'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json',
        '.geojson':'application/geo+json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'}

def cache_path(kind, key):
    os.makedirs(os.path.join(CACHE, kind), exist_ok=True)
    return os.path.join(CACHE, kind, hashlib.sha1(key.encode()).hexdigest())

def fetch(url, binary=False):
    req = urllib.request.Request(url, headers={'User-Agent':'yane-teian-demo/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read(), r.headers.get('Content-Type','')
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get('Content-Type','')

def mock_solar(lat, lng, fpa):
    """Solar API buildingInsights と同じ形の疑似データ(UI 確認用)"""
    rnd = random.Random(f'{lat:.5f},{lng:.5f}')
    fpa = fpa or rnd.uniform(50, 90)
    pitch = rnd.choice([20, 25, 27, 30])
    roof_area = fpa / math.cos(math.radians(pitch))
    d = math.sqrt(fpa) / 2 / 111320.0
    segs = []
    azs = rnd.choice([[180, 0], [90, 270], [180, 0, 90, 270]])
    for i, az in enumerate(azs):
        a = roof_area / len(azs) * rnd.uniform(0.8, 1.2)
        segs.append({'pitchDegrees': pitch, 'azimuthDegrees': az,
                     'stats': {'areaMeters2': round(a,1), 'sunshineQuantiles': [900+ i*20 + k*40 for k in range(11)], 'groundAreaMeters2': round(a*math.cos(math.radians(pitch)),1)},
                     'center': {'latitude': lat + d*(0.5 if az==0 else -0.5 if az==180 else 0), 'longitude': lng + d*(0.5 if az==90 else -0.5 if az==270 else 0)},
                     'boundingBox': {'sw': {'latitude': lat - d*(1 if az in (180,90,270) else 0.1), 'longitude': lng - d*(1 if az in (0,180,270) else 0.1)},
                                     'ne': {'latitude': lat + d*(1 if az in (0,90,270) else 0.1), 'longitude': lng + d*(1 if az in (0,180,90) else 0.1)}},
                     'planeHeightAtCenterMeters': 7.0})
    pw = 250; usable = sum(s['stats']['areaMeters2'] for s in segs if s['azimuthDegrees'] in (90,180,270)) * 0.55
    maxp = max(4, int(usable / 1.7))
    configs = []
    for n in range(4, maxp+1):
        configs.append({'panelsCount': n, 'yearlyEnergyDcKwh': round(n * pw/1000 * 1150 * rnd.uniform(0.95,1.05), 1)})
    return {'name': 'buildings/mock', 'center': {'latitude': lat, 'longitude': lng},
            'boundingBox': {'sw': {'latitude': lat-d, 'longitude': lng-d}, 'ne': {'latitude': lat+d, 'longitude': lng+d}},
            'imageryDate': {'year': 2024, 'month': 5, 'day': 1}, 'imageryQuality': 'MOCK',
            'solarPotential': {'maxArrayPanelsCount': maxp, 'maxArrayAreaMeters2': round(maxp*1.7,1), 'maxSunshineHoursPerYear': 1250,
                               'carbonOffsetFactorKgPerMwh': 428, 'panelCapacityWatts': pw, 'panelHeightMeters': 1.65, 'panelWidthMeters': 0.99,
                               'wholeRoofStats': {'areaMeters2': round(roof_area,1), 'groundAreaMeters2': round(fpa,1), 'sunshineQuantiles': [900+k*40 for k in range(11)]},
                               'roofSegmentStats': segs, 'solarPanelConfigs': configs}}

class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a): sys.stderr.write('%s %s\n' % (self.address_string(), fmt % a))

    def send(self, code, body, ctype='application/json', extra=None):
        if isinstance(body, (dict, list)): body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        p = u.path
        try:
            if p in ('/', '/index.html'):
                html = open(os.path.join(WEB, 'index.html'), encoding='utf-8').read()
                html = html.replace('__BROWSER_KEY__', BROWSER_KEY).replace('__MOCK__', 'true' if MOCK else 'false')
                return self.send(200, html.encode(), 'text/html; charset=utf-8')
            if p == '/api/status':
                n = sum(len(f) for _, _, f in os.walk(CACHE)) if os.path.exists(CACHE) else 0
                u = usage_today()
                return self.send(200, {'serverKey': bool(SERVER_KEY), 'browserKey': bool(BROWSER_KEY), 'mock': MOCK, 'cached': n,
                                       'today': {k: {'used': u.get(k, 0), 'limit': v} for k, v in LIMITS.items()}})
            if p == '/api/solar': return self.api_solar(q)
            if p == '/api/geocode': return self.api_geocode(q)
            if p == '/api/revgeocode': return self.api_revgeocode(q)
            if p == '/api/staticmap': return self.api_staticmap(u.query)
            if p.startswith('/data/') or p.startswith('/web/'):
                return self.static(p)
            return self.send(404, {'error': 'not found'})
        except Exception as e:
            return self.send(500, {'error': str(e)})

    def static(self, p):
        base = ROOT
        fp = os.path.normpath(os.path.join(base, p.lstrip('/')))
        if not fp.startswith(base) or '/cache/' in fp: return self.send(403, {'error':'forbidden'})
        ext = os.path.splitext(fp)[1]; ctype = MIME.get(ext, 'application/octet-stream')
        if os.path.exists(fp + '.gz') and 'gzip' in self.headers.get('Accept-Encoding',''):
            return self.send(200, open(fp+'.gz','rb').read(), ctype, {'Content-Encoding':'gzip'})
        if os.path.exists(fp): return self.send(200, open(fp,'rb').read(), ctype)
        if os.path.exists(fp + '.gz'): return self.send(200, gzip.open(fp+'.gz','rb').read(), ctype)
        return self.send(404, {'error':'not found'})

    def api_solar(self, q):
        lat, lng = float(q['lat'][0]), float(q['lng'][0])
        quality = q.get('quality', ['LOW'])[0]
        fpa = float(q['fpa'][0]) if 'fpa' in q else None
        if MOCK: return self.send(200, mock_solar(lat, lng, fpa))
        key = f'{lat:.6f},{lng:.6f},{quality}'
        cp = cache_path('solar', key)
        # Solar API 規約(20.2): Building Insights のキャッシュは最大30日。超えたものは削除して取り直す
        if os.path.exists(cp):
            import time
            if time.time() - os.path.getmtime(cp) < SOLAR_CACHE_DAYS * 86400: return self.send(200, open(cp,'rb').read())
            os.remove(cp)
        if not usage_take('solar'): return self.send(429, limit_error('solar'))
        url = ('https://solar.googleapis.com/v1/buildingInsights:findClosest?' +
               urllib.parse.urlencode({'location.latitude': lat, 'location.longitude': lng, 'requiredQuality': quality, 'key': SERVER_KEY}))
        code, body, _ = fetch(url)
        if code == 200: open(cp,'wb').write(body)
        return self.send(code, body)

    def api_geocode(self, q):
        addr = q.get('address', [''])[0]
        if not addr: return self.send(400, {'error':'address required'})
        if MOCK: return self.send(200, {'status':'MOCK','results':[]})
        cp = cache_path('geocode', addr)
        if os.path.exists(cp): return self.send(200, open(cp,'rb').read())
        if not usage_take('geocode'): return self.send(429, limit_error('geocode'))
        url = 'https://maps.googleapis.com/maps/api/geocode/json?' + urllib.parse.urlencode({'address': addr, 'region':'jp', 'language':'ja', 'key': SERVER_KEY})
        code, body, _ = fetch(url)
        if code == 200: open(cp,'wb').write(body)
        return self.send(code, body)

    def api_revgeocode(self, q):
        lat, lng = float(q['lat'][0]), float(q['lng'][0])
        if MOCK: return self.send(200, {'status':'MOCK','results':[{'formatted_address':'埼玉県戸田市(疑似住所)'}]})
        cp = cache_path('revgeocode', f'{lat:.6f},{lng:.6f}')
        if os.path.exists(cp): return self.send(200, open(cp,'rb').read())
        if not usage_take('geocode'): return self.send(429, limit_error('geocode'))
        url = 'https://maps.googleapis.com/maps/api/geocode/json?' + urllib.parse.urlencode({'latlng': f'{lat},{lng}', 'language':'ja', 'key': SERVER_KEY})
        code, body, _ = fetch(url)
        if code == 200: open(cp,'wb').write(body)
        return self.send(code, body)

    def api_staticmap(self, query):
        allowed = {'center','zoom','size','scale','maptype','path','markers','format','style'}
        pairs = [(k, v) for k, v in urllib.parse.parse_qsl(query, keep_blank_values=True) if k in allowed]
        if MOCK:
            # 1x1 の透明 PNG 代替(疑似モード)
            png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cfc00000020101008b7c5aa20000000049454e44ae426082')
            return self.send(200, png, 'image/png')
        cp = cache_path('staticmap', urllib.parse.urlencode(pairs))
        if os.path.exists(cp): return self.send(200, open(cp,'rb').read(), 'image/png')
        if not usage_take('staticmap'): return self.send(429, limit_error('staticmap'))
        url = 'https://maps.googleapis.com/maps/api/staticmap?' + urllib.parse.urlencode(pairs + [('key', SERVER_KEY)])
        code, body, ctype = fetch(url, binary=True)
        if code == 200: open(cp,'wb').write(body)
        return self.send(code, body, ctype or 'image/png')

if __name__ == '__main__':
    os.makedirs(CACHE, exist_ok=True); purge_solar_cache()
    print(f'serverKey={"set" if SERVER_KEY else "MISSING"} browserKey={"set" if BROWSER_KEY else "MISSING"} mock={MOCK}', file=sys.stderr)
    print(f'http://localhost:{PORT}/', file=sys.stderr)
    ThreadingHTTPServer(('0.0.0.0', PORT), H).serve_forever()
