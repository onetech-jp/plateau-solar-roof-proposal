#!/usr/bin/env python3
"""PLATEAU CityGML(bldg) → 建物輪郭 GeoJSON 変換

使い方:
  python3 scripts/citygml_to_geojson.py <citygml.zip or udx/bldg dir> <out.geojson>

抽出する属性(短いキー名でサイズ削減):
  id   gml:id
  y    建築年 bldg:yearOfConstruction (不明=null)
  u    用途 bldg:usage (codelist で日本語化)
  h    最高高さ bldg:measuredHeight [m]
  st   地上階数 bldg:storeysAboveGround
  str  構造 uro:buildingStructureType (codelist で日本語化)
  tfa  延床面積 uro:totalFloorArea [㎡]
  fpa  建築面積(輪郭の面積) [㎡] 計算値
  per  外周長 [m] 計算値
  addr 住所 bldg:address
座標は EPSG:6697(JGD2011 緯度経度)のまま。
"""
import sys, os, io, json, math, zipfile, re
from lxml import etree

NS = {
    'gml': 'http://www.opengis.net/gml',
    'bldg': 'http://www.opengis.net/citygml/building/2.0',
    'core': 'http://www.opengis.net/citygml/2.0',
    'uro': 'https://www.geospatial.jp/iur/uro/3.0',
    'gen': 'http://www.opengis.net/citygml/generics/2.0',
    'xAL': 'urn:oasis:names:tc:ciq:xsdschema:xAL:2.0',
}
URO_ALT = ['https://www.geospatial.jp/iur/uro/3.0', 'https://www.geospatial.jp/iur/uro/2.0', 'https://www.geospatial.jp/iur/uro/3.1', 'https://www.geospatial.jp/iur/uro/3.2']

def load_codelist(read_fn, name):
    """codelists/<name>.xml → {code: label}"""
    try:
        data = read_fn(name)
    except Exception:
        return {}
    m = {}
    try:
        root = etree.fromstring(data)
        for d in root.iter('{%s}Definition' % NS['gml']):
            desc = d.find('gml:description', NS)
            nm = d.find('gml:name', NS)
            if desc is not None and nm is not None:
                m[nm.text.strip()] = desc.text.strip()
    except Exception:
        pass
    return m

def local_xy(lon, lat, lon0, lat0):
    kx = 111320.0 * math.cos(math.radians(lat0))
    ky = 110540.0
    return (lon - lon0) * kx, (lat - lat0) * ky

def poly_area_perimeter(ring):
    """ring: [(lon,lat),...] → (area m2, perimeter m)"""
    if len(ring) < 3: return 0.0, 0.0
    lon0 = sum(p[0] for p in ring)/len(ring); lat0 = sum(p[1] for p in ring)/len(ring)
    xy = [local_xy(p[0], p[1], lon0, lat0) for p in ring]
    a = 0.0; per = 0.0
    n = len(xy)
    for i in range(n):
        x1,y1 = xy[i]; x2,y2 = xy[(i+1)%n]
        a += x1*y2 - x2*y1
        per += math.hypot(x2-x1, y2-y1)
    return abs(a)/2.0, per

def parse_poslist(txt, dim=3):
    v = [float(t) for t in txt.split()]
    pts = []
    for i in range(0, len(v) - dim + 1, dim):
        lat, lon = v[i], v[i+1]   # EPSG:6697 は 緯度,経度,高さ の順
        z = v[i+2] if dim == 3 else 0.0
        pts.append((lon, lat, z))
    return pts

def polygons_of(elem):
    """要素配下の gml:Polygon → [(ring pts(lon,lat,z)), ...] 外周のみ"""
    out = []
    for poly in elem.iter('{%s}Polygon' % NS['gml']):
        ext = poly.find('gml:exterior//gml:posList', NS)
        if ext is None or not ext.text: continue
        dim = int(ext.get('srsDimension', '3'))
        pts = parse_poslist(ext.text, dim)
        if len(pts) >= 4: out.append(pts)
    return out

def footprint(b):
    # 1) lod0FootPrint / lod0RoofEdge
    for tag in ('lod0FootPrint', 'lod0RoofEdge'):
        e = b.find('bldg:%s' % tag, NS)
        if e is not None:
            polys = polygons_of(e)
            if polys: return max(polys, key=lambda r: poly_area_perimeter([(p[0],p[1]) for p in r])[0])
    # 2) lod1Solid の底面(z が最小で水平な面)
    e = b.find('bldg:lod1Solid', NS)
    if e is None: e = b.find('bldg:lod2Solid', NS)
    if e is not None:
        polys = polygons_of(e)
        flat = [r for r in polys if max(p[2] for p in r) - min(p[2] for p in r) < 0.05]
        if flat:
            return min(flat, key=lambda r: sum(p[2] for p in r)/len(r))
        if polys:
            return max(polys, key=lambda r: poly_area_perimeter([(p[0],p[1]) for p in r])[0])
    return None

def text(b, path):
    e = b.find(path, NS)
    return e.text.strip() if e is not None and e.text else None

def find_uro(b, local):
    for ns in URO_ALT:
        for e in b.iter('{%s}%s' % (ns, local)):
            if e.text: return e.text.strip()
    return None

def address_of(b):
    parts = []
    for e in b.iter('{%s}LocalityName' % NS['xAL']):
        if e.text: parts.append(e.text.strip())
    for e in b.iter('{%s}ThoroughfareName' % NS['xAL']):
        if e.text: parts.append(e.text.strip())
    for e in b.iter('{%s}PremiseNumber' % NS['xAL']):
        if e.text: parts.append(e.text.strip())
    return ''.join(parts) or None

def convert(gml_bytes, usage_cl, struct_cl, feats, stats):
    root = etree.fromstring(gml_bytes)
    for b in root.iter('{%s}Building' % NS['bldg']):
        stats['n'] += 1
        ring = footprint(b)
        if not ring:
            stats['nofp'] += 1; continue
        ring2 = [(round(p[0],7), round(p[1],7)) for p in ring]
        if ring2[0] != ring2[-1]: ring2.append(ring2[0])
        area, per = poly_area_perimeter(ring2[:-1])
        if area < 1: stats['tiny'] += 1; continue
        y = text(b, 'bldg:yearOfConstruction')
        try:
            y = int(y) if y else None
            if y is not None and y < 1000: y = None
        except ValueError: y = None
        if y is None: stats['noyear'] += 1
        u = text(b, 'bldg:usage'); u = usage_cl.get(u, u) if u else None
        h = text(b, 'bldg:measuredHeight')
        st = text(b, 'bldg:storeysAboveGround')
        s = find_uro(b, 'buildingStructureType'); s = struct_cl.get(s, s) if s else None
        tfa = find_uro(b, 'totalFloorArea')
        gid = b.get('{%s}id' % NS['gml'])
        props = {'id': gid, 'y': y, 'u': u,
                 'h': round(float(h),1) if h else None,
                 'st': int(float(st)) if st else None,
                 'str': s,
                 'tfa': round(float(tfa),1) if tfa else None,
                 'fpa': round(area,1), 'per': round(per,1),
                 'addr': address_of(b)}
        # PLATEAU の不明値(9999 / -9999 / '不明')を落とす
        for k in ('st','tfa','h'):
            if k in props and props[k] is not None and (props[k] >= 9999 or props[k] <= -9999): props[k] = None
        for k in ('u','str'):
            if props.get(k) == '不明': props[k] = None
        props = {k:v for k,v in props.items() if v is not None}
        feats.append({'type':'Feature','properties':props,
                      'geometry':{'type':'Polygon','coordinates':[[list(p) for p in ring2]]}})

def main():
    src, out = sys.argv[1], sys.argv[2]
    feats = []; stats = {'n':0,'nofp':0,'tiny':0,'noyear':0}
    if src.endswith('.zip'):
        z = zipfile.ZipFile(src)
        names = z.namelist()
        cl = {n.split('/')[-1]: n for n in names if 'codelists/' in n and n.endswith('.xml')}
        rd = lambda name: z.read(cl[name])
        usage_cl = load_codelist(rd, 'Building_usage.xml')
        struct_cl = load_codelist(rd, 'BuildingDetailAttribute_buildingStructureType.xml')
        gmls = [n for n in names if re.search(r'(^|/)udx/bldg/[^/]+\.gml$', n)]
        print(f'codelists usage={len(usage_cl)} struct={len(struct_cl)}; bldg gml files={len(gmls)}', file=sys.stderr)
        for i, n in enumerate(gmls):
            convert(z.read(n), usage_cl, struct_cl, feats, stats)
            print(f'  [{i+1}/{len(gmls)}] {os.path.basename(n)} total={len(feats)}', file=sys.stderr)
    else:
        base = src
        cdir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(base))), 'codelists')
        rd = lambda name: open(os.path.join(cdir, name), 'rb').read()
        usage_cl = load_codelist(rd, 'Building_usage.xml')
        struct_cl = load_codelist(rd, 'BuildingDetailAttribute_buildingStructureType.xml')
        gmls = sorted(f for f in os.listdir(base) if f.endswith('.gml'))
        for i, f in enumerate(gmls):
            convert(open(os.path.join(base, f),'rb').read(), usage_cl, struct_cl, feats, stats)
            print(f'  [{i+1}/{len(gmls)}] {f} total={len(feats)}', file=sys.stderr)
    fc = {'type':'FeatureCollection','features':feats,
          'meta':{'source':'PLATEAU 3D都市モデル(国土交通省)','stats':stats}}
    with open(out, 'w') as f:
        json.dump(fc, f, ensure_ascii=False, separators=(',',':'))
    print(json.dumps(stats), file=sys.stderr)
    print(f'wrote {out} features={len(feats)} size={os.path.getsize(out)/1e6:.1f}MB', file=sys.stderr)

if __name__ == '__main__':
    main()
