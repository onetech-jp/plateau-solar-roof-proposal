/* 屋根提案シート デモ: Google Maps + PLATEAU 建物輪郭 + Solar API */
(function () {
  const NOW = new Date().getFullYear();
  const $ = id => document.getElementById(id);
  const yen = n => '¥' + Math.round(n).toLocaleString('ja-JP');
  const num = (n, d = 1) => (n == null ? '-' : Number(n).toLocaleString('ja-JP', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
  const TSUBO = 3.305785;
  const TODA = { lat: 35.8176, lng: 139.6776 };
  const SEG_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#be185d', '#4d7c0f'];

  let params = null, defaultParams = null;
  let map, feats = [], visibleIds = new Set(), selected = null, solar = null, overlays = [], searchMarker = null;
  let sel = { panels: null, battery: false, roofMaterial: 'スレート', wallGrade: 'シリコン', narrow: false, pitch: null };
  let measure = { on: false, poly: null, path: [], area: 0 };
  let lastAddress = null;

  // ---------- params ----------
  async function loadParams() {
    defaultParams = await fetch('/web/params.json').then(r => r.json());
    try { const s = localStorage.getItem('yane.params'); params = s ? JSON.parse(s) : JSON.parse(JSON.stringify(defaultParams)); }
    catch (_) { params = JSON.parse(JSON.stringify(defaultParams)); }
    sel.roofMaterial = Object.keys(params.paint.roofUnit)[0]; sel.wallGrade = Object.keys(params.paint.wallUnit)[0]; sel.pitch = params.paint.defaultPitch;
  }
  $('settingsBtn').onclick = () => { $('paramsText').value = JSON.stringify(params, null, 2); $('settings').classList.add('open'); };
  $('paramsClose').onclick = () => $('settings').classList.remove('open');
  $('paramsReset').onclick = () => { $('paramsText').value = JSON.stringify(defaultParams, null, 2); };
  $('paramsSave').onclick = () => {
    try { params = JSON.parse($('paramsText').value); try { localStorage.setItem('yane.params', JSON.stringify(params)); } catch (_) {} $('settings').classList.remove('open'); renderPanel(); }
    catch (e) { alert('JSON の形式が正しくありません: ' + e.message); }
  };

  // ---------- styling ----------
  const MODES = {
    quake: { legend: [['#d32f2f', '〜1981年(旧耐震)'], ['#f57c00', '1982〜2000年'], ['#388e3c', '2001年〜'], ['#9e9e9e', '築年不明']],
      color: y => y == null ? '#9e9e9e' : y <= 1981 ? '#d32f2f' : y <= 2000 ? '#f57c00' : '#388e3c' },
    age: { legend: [['#7f1d1d', '築50年以上'], ['#ea580c', '築30〜49年'], ['#facc15', '築15〜29年'], ['#22c55e', '築15年未満'], ['#9e9e9e', '築年不明']],
      color: y => { if (y == null) return '#9e9e9e'; const a = NOW - y; return a >= 50 ? '#7f1d1d' : a >= 30 ? '#ea580c' : a >= 15 ? '#facc15' : '#22c55e'; } },
  };
  let mode = 'quake';
  function renderLegend() { $('legendItems').innerHTML = MODES[mode].legend.map(([c, t]) => `<div class="row"><span class="sw" style="background:${c}"></span>${t}</div>`).join(''); }
  document.querySelectorAll('input[name=mode]').forEach(r => r.onchange = () => { mode = r.value; renderLegend(); map.data.setStyle(styleFn); });
  ['minAge', 'hideUnknown'].forEach(id => $(id).onchange = refreshVisible);
  document.querySelectorAll('.usage').forEach(c => c.onchange = refreshVisible);

  function passFilter(p) {
    const minAge = Number($('minAge').value);
    if (p.y == null) { if ($('hideUnknown').checked || minAge > 0 && false) return false; }
    else if (minAge > 0 && NOW - p.y < minAge) return false;
    const us = [...document.querySelectorAll('.usage:checked')].map(c => c.value);
    const main = ['住宅', '店舗等併用住宅', '共同住宅'];
    const u = p.u || '';
    if (main.includes(u)) return us.includes(u);
    return us.includes('__other');
  }
  function styleFn(f) {
    const y = f.getProperty('y'); const isSel = selected && f.getProperty('id') === selected.id;
    return { fillColor: isSel ? '#00e5ff' : MODES[mode].color(y), fillOpacity: isSel ? .6 : .45, strokeColor: isSel ? '#00bcd4' : '#333', strokeWeight: isSel ? 3 : .6, clickable: !measure.on };
  }

  // ---------- data ----------
  async function loadBuildings() {
    $('status').textContent = '建物データ読込中…';
    const gj = await fetch('/data/toda_buildings.geojson').then(r => r.json());
    feats = gj.features.map(f => {
      const ring = f.geometry.coordinates[0]; let s = 90, w = 180, n = -90, e = -180, cx = 0, cy = 0;
      for (const [x, y] of ring) { if (y < s) s = y; if (y > n) n = y; if (x < w) w = x; if (x > e) e = x; }
      for (let i = 0; i < ring.length - 1; i++) { cx += ring[i][0]; cy += ring[i][1]; }
      f.bbox = [w, s, e, n]; f.center = { lat: cy / (ring.length - 1), lng: cx / (ring.length - 1) }; return f;
    });
    const withY = feats.filter(f => f.properties.y != null).length;
    $('status').textContent = `建物 ${feats.length.toLocaleString()} 棟(築年あり ${withY.toLocaleString()})`;
    refreshVisible();
  }
  function refreshVisible() {
    if (!map || !feats.length) return;
    const z = map.getZoom(); const hint = $('hint');
    map.data.forEach(f => map.data.remove(f)); visibleIds = new Set();
    if (z < 15) { hint.textContent = 'ズーム15以上で建物を表示します'; hint.style.display = 'block'; $('countInfo').textContent = ''; return; }
    const b = map.getBounds(); if (!b) return;
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    const sub = []; let total = 0;
    for (const f of feats) {
      const [w, s, e, n] = f.bbox; if (e < sw.lng() || w > ne.lng() || n < sw.lat() || s > ne.lat()) continue;
      total++; if (!passFilter(f.properties)) continue; sub.push(f); if (sub.length >= 8000) break;
    }
    hint.style.display = 'none';
    map.data.addGeoJson({ type: 'FeatureCollection', features: sub });
    sub.forEach(f => visibleIds.add(f.properties.id));
    $('countInfo').textContent = `表示中 ${sub.length.toLocaleString()} 棟 / 画面内 ${total.toLocaleString()} 棟`;
  }

  // ---------- map ----------
  window.initMap = function () {
    map = new google.maps.Map($('map'), { center: TODA, zoom: 16, mapTypeId: 'roadmap', mapTypeControl: true, streetViewControl: true, fullscreenControl: false, gestureHandling: 'greedy', tilt: 0 });
    map.data.setStyle(styleFn);
    map.addListener('idle', refreshVisible);
    map.data.addListener('click', e => { if (measure.on) return; selectFeature(e.feature); });
    map.addListener('click', e => { if (measure.on) addMeasurePoint(e.latLng); });
    renderLegend(); loadBuildings();
  };

  // Solar API が返した建物が PLATEAU の輪郭と一致しているかの簡易判定
  function solarMismatch(f, S) {
    if (!S || !S.groundArea) return null;
    const p = f.properties; const ratio = S.groundArea / p.fpa;
    const c = solar.center; const inside = c ? pointInRing({ lat: c.latitude, lng: c.longitude }, f.geometry.coordinates[0]) : true;
    if (!inside) return 'Solar API の建物中心が輪郭の外(隣接建物を拾った可能性)';
    if (ratio < 0.6) return `Solar API の投影面積が輪郭の${Math.round(ratio * 100)}%(建物の一部、または別棟の可能性)`;
    if (ratio > 1.6) return `Solar API の投影面積が輪郭の${Math.round(ratio * 100)}%(複数棟を含む可能性)`;
    return null;
  }
  function featureById(id) { return feats.find(f => f.properties.id === id); }
  function clearOverlays() { overlays.forEach(o => o.setMap(null)); overlays = []; }

  async function selectFeature(dataFeature) {
    const id = dataFeature.getProperty('id'); const f = featureById(id); if (!f) return;
    selected = f; solar = null; sel.panels = null; lastAddress = f.properties.addr || null;
    map.data.setStyle(styleFn); clearOverlays();
    renderPanel();
    const p = f.properties, c = f.center;
    const [solarRes, addrRes] = await Promise.allSettled([
      fetch(`/api/solar?lat=${c.lat}&lng=${c.lng}&quality=LOW&fpa=${p.fpa}`).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error && j.error.message || JSON.stringify(j)); return j; }),
      lastAddress ? Promise.resolve(null) : fetch(`/api/revgeocode?lat=${c.lat}&lng=${c.lng}`).then(r => r.json()),
    ]);
    if (selected !== f) return;
    if (solarRes.status === 'fulfilled') { solar = solarRes.value; drawSolarOverlays(); } else { solar = { error: solarRes.reason.message }; }
    if (addrRes.status === 'fulfilled' && addrRes.value && addrRes.value.results && addrRes.value.results[0]) {
      lastAddress = addrRes.value.results[0].formatted_address.replace(/^日本、?/, '').replace(/^〒?\d{3}-\d{4}\s*/, '');
    }
    renderPanel();
  }

  function drawSolarOverlays() {
    clearOverlays(); if (!solar || !solar.solarPotential) return;
    const bb = solar.boundingBox;
    if (bb) overlays.push(new google.maps.Rectangle({ map, bounds: { south: bb.sw.latitude, west: bb.sw.longitude, north: bb.ne.latitude, east: bb.ne.longitude }, strokeColor: '#ff6d00', strokeWeight: 2, fillOpacity: 0, clickable: false }));
    (solar.solarPotential.roofSegmentStats || []).forEach((s, i) => {
      const col = SEG_COLORS[i % SEG_COLORS.length]; const b = s.boundingBox;
      if (b) overlays.push(new google.maps.Rectangle({ map, bounds: { south: b.sw.latitude, west: b.sw.longitude, north: b.ne.latitude, east: b.ne.longitude }, strokeColor: col, strokeWeight: 2, fillColor: col, fillOpacity: .15, clickable: false }));
      if (s.center) overlays.push(new google.maps.Marker({ map, position: { lat: s.center.latitude, lng: s.center.longitude }, label: { text: String.fromCharCode(65 + i), color: '#fff', fontWeight: '700', fontSize: '12px' }, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 11, fillColor: col, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 1.5 }, clickable: false }));
    });
  }

  // ---------- panel ----------
  function renderPanel() {
    if (!selected) { $('panelEmpty').style.display = 'block'; $('panelBody').style.display = 'none'; return; }
    $('panelEmpty').style.display = 'none'; $('panelBody').style.display = 'block';
    const p = selected.properties;
    const yearTxt = p.y ? `${p.y}年(築${NOW - p.y}年)` : '不明';
    let html = `<h2>建物情報 <span class="badge">PLATEAU</span></h2>
      <div class="muted">${lastAddress || '住所取得中…'}</div>
      <table class="kv">
        <tr><td>建築年</td><td>${yearTxt}</td></tr>
        <tr><td>用途</td><td>${p.u || '-'}</td></tr>
        <tr><td>構造</td><td>${p.str || '-'}</td></tr>
        <tr><td>地上階数 / 高さ</td><td>${p.st != null ? p.st + '階' : '-'} / ${p.h != null ? p.h + ' m' : '-'}</td></tr>
        <tr><td>建築面積(輪郭)</td><td>${num(p.fpa)} ㎡(${num(p.fpa / TSUBO)}坪)</td></tr>
        <tr><td>延床面積</td><td>${p.tfa != null ? num(p.tfa) + ' ㎡' : '-'}</td></tr>
        <tr><td>外周長</td><td>${num(p.per)} m</td></tr>
      </table>`;
    // Solar
    html += `<h2>屋根情報(太陽光提案用) <span class="badge">Solar API</span>${solar && solar.imageryQuality === 'MOCK' ? '<span class="badge warn">疑似データ</span>' : ''}</h2>
      <div class="muted">Source: Includes solar data from Google. この区画の数値は太陽光の設置可能性の判断と提案にのみ使います(Google の利用規約)。</div>`;
    if (!solar) html += `<div class="muted">Solar API 問い合わせ中…</div>`;
    else if (solar.error) html += `<div class="muted">取得できませんでした: ${solar.error}<br>(対象外エリアの可能性。塗装概算は建築面積から推定します)</div>`;
    else {
      const S = Estimate.computeSolar(solar, sel, params.solar);
      const d = solar.imageryDate ? `${solar.imageryDate.year}/${solar.imageryDate.month}` : '';
      const mm = solarMismatch(selected, S);
      html += `<div class="muted">画像品質 ${solar.imageryQuality} ${d}</div>${mm ? `<div class="badge warn" style="margin:4px 0;white-space:normal">要確認: ${mm}</div>` : ''}
        <table class="kv">
          <tr><td>屋根実面積(勾配込み)</td><td>${num(S.roofArea)} ㎡</td></tr>
          <tr><td>屋根投影面積</td><td>${num(S.groundArea)} ㎡</td></tr>
          <tr><td>南〜東西向き面積</td><td>${num(S.southArea)} ㎡</td></tr>
          <tr><td>パネル設置可能</td><td>最大 ${S.maxPanels} 枚 / ${num(S.maxArea)} ㎡</td></tr>
          <tr><td>年間日照時間</td><td>${num(S.sunHours, 0)} 時間</td></tr>
        </table>
        <table class="kv" style="margin-top:6px"><tr><th>面</th><th>方位</th><th>勾配</th><th>面積</th></tr>
        ${S.segs.map(s => `<tr><td><b style="color:${SEG_COLORS[s.idx % 8]}">${s.label}</b></td><td>${s.dir}(${num(s.az, 0)}°)</td><td>${num(s.pitch, 0)}°</td><td class="num">${num(s.area)} ㎡</td></tr>`).join('')}
        </table>`;
      // 太陽光概算
      html += `<h2>太陽光 概算</h2>
        <div class="row"><label>パネル枚数 <input type="number" id="panels" min="4" max="${S.maxPanels}" value="${S.panels}" style="width:70px"> / 最大${S.maxPanels}</label>
        <label><input type="checkbox" id="battery" ${sel.battery ? 'checked' : ''}> 蓄電池あり</label></div>
        <table class="kv">
          <tr><td>設置容量</td><td class="num">${num(S.kw, 2)} kW(${S.panels}枚 × ${params.solar.panelWatt}W)</td></tr>
          <tr><td>年間発電量(AC)</td><td class="num">${num(S.kwhAc, 0)} kWh</td></tr>
          <tr><td>機器・工事費</td><td class="num">${yen(S.equip)}</td></tr>
          <tr><td>補助金</td><td class="num">−${yen(S.subsidy)}</td></tr>
          <tr class="total"><td>初期費用(概算)</td><td class="num">${yen(S.cost)}</td></tr>
          <tr><td>年間経済効果(初年度)</td><td class="num">${yen(S.firstYear)}</td></tr>
          <tr><td>投資回収</td><td class="num">${S.payback ? `約 ${S.payback} 年` : `${params.solar.horizonYears}年超`}</td></tr>
          <tr><td>${params.solar.horizonYears}年累計効果</td><td class="num">${yen(S.total)}</td></tr>
          <tr><td>CO₂削減(年)</td><td class="num">${num(S.co2kg, 0)} kg</td></tr>
        </table>`;
    }
    // 塗装概算
    const Pn = Estimate.computePaint(p, null, sel, params.paint);
    html += `<h2>屋根・外壁塗装 概算 <span class="badge">PLATEAU</span></h2>
      <div class="muted">屋根面積は PLATEAU の建築面積 × 勾配係数で推定(Solar API のデータは使いません)。</div>
      <div class="row"><label>勾配 <select id="pitch">${Object.keys(params.paint.pitchOptions).map(k => `<option ${k === sel.pitch ? 'selected' : ''}>${k}</option>`).join('')}</select></label></div>
      <div class="row"><label>屋根材 <select id="roofMaterial">${Object.keys(params.paint.roofUnit).map(k => `<option ${k === sel.roofMaterial ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <label>塗料 <select id="wallGrade">${Object.keys(params.paint.wallUnit).map(k => `<option ${k === sel.wallGrade ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <label><input type="checkbox" id="narrow" ${sel.narrow ? 'checked' : ''}> 狭小地</label></div>
      <table class="kv">
        <tr><td>軒高(推定)</td><td class="num">${num(Pn.eave)} m <span class="muted">${Pn.eaveSrc}</span></td></tr>
        <tr><td>足場架面積</td><td class="num">(${num(Pn.per)}+${params.paint.scaffoldOffset})m × ${num(Pn.scH)}m = ${num(Pn.scArea, 0)} ㎡</td></tr>
        <tr><td>足場(組解・シート・基本料)</td><td class="num">${yen(Pn.scaffold)}</td></tr>
        ${Pn.roofScaffold ? `<tr><td>屋根足場</td><td class="num">${yen(Pn.roofScaffold)}</td></tr>` : ''}
        <tr><td>屋根塗装 ${num(Pn.roofArea, 0)}㎡ × ${yen(Pn.roofUnit)}</td><td class="num">${yen(Pn.roof)}</td></tr>
        <tr><td>外壁塗装 ${num(Pn.wallArea, 0)}㎡ × ${yen(Pn.wallUnit)}</td><td class="num">${yen(Pn.wall)}</td></tr>
        <tr><td>高圧洗浄</td><td class="num">${yen(Pn.wash)}</td></tr>
        <tr><td>付帯部(樋・破風・軒天)</td><td class="num">${yen(Pn.acc)}</td></tr>
        <tr><td>諸経費 ${Math.round(params.paint.overheadRate * 100)}%</td><td class="num">${yen(Pn.overhead)}</td></tr>
        <tr class="total"><td>合計(税抜・概算)</td><td class="num">${yen(Pn.total)}</td></tr>
      </table>
      ${Pn.notes.length ? `<div class="muted">${Pn.notes.join(' / ')}</div>` : ''}
      <div class="muted">屋根面積: ${Pn.roofSrc}</div>`;
    if (measure.area > 0) html += `<h2>敷地面積(手動計測)</h2><div>${num(measure.area)} ㎡(${num(measure.area / TSUBO)}坪) <span class="muted">建ぺい率 ${num(p.fpa / measure.area * 100, 0)}%</span></div>`;
    html += `<div class="row" style="margin-top:12px"><button id="sheetBtn" class="primary" ${!solar ? 'disabled' : ''}>提案シートを作成</button><button id="zoomBtn">この建物へズーム</button></div>
      <div class="muted" style="margin-top:8px">数値はすべて航空写真・公開データからの推定値です。単価は「単価設定」で御社の値に差し替えてください。</div>`;
    $('panelBody').innerHTML = html;
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    on('panels', 'change', e => { sel.panels = Number(e.target.value); renderPanel(); });
    on('battery', 'change', e => { sel.battery = e.target.checked; renderPanel(); });
    on('roofMaterial', 'change', e => { sel.roofMaterial = e.target.value; renderPanel(); });
    on('wallGrade', 'change', e => { sel.wallGrade = e.target.value; renderPanel(); });
    on('narrow', 'change', e => { sel.narrow = e.target.checked; renderPanel(); });
    on('pitch', 'change', e => { sel.pitch = e.target.value; renderPanel(); });
    on('sheetBtn', 'click', openSheet);
    on('zoomBtn', 'click', () => { map.setMapTypeId('hybrid'); map.setZoom(20); map.panTo(selected.center); });
  }

  // ---------- 提案シート ----------
  function staticMapUrl(f, zoom, withSegs) {
    const ring = f.geometry.coordinates[0].map(([x, y]) => `${y.toFixed(6)},${x.toFixed(6)}`);
    const q = [['center', `${f.center.lat},${f.center.lng}`], ['zoom', zoom], ['size', '640x400'], ['scale', 2], ['maptype', 'satellite'],
      ['path', `color:0xff6d00ff|weight:3|fillcolor:0xff6d0022|${ring.join('|')}`]];
    if (withSegs && solar && solar.solarPotential) (solar.solarPotential.roofSegmentStats || []).forEach((s, i) => {
      const b = s.boundingBox; if (!b) return; const col = SEG_COLORS[i % 8].slice(1);
      q.push(['path', `color:0x${col}ff|weight:2|fillcolor:0x${col}33|${b.sw.latitude.toFixed(6)},${b.sw.longitude.toFixed(6)}|${b.sw.latitude.toFixed(6)},${b.ne.longitude.toFixed(6)}|${b.ne.latitude.toFixed(6)},${b.ne.longitude.toFixed(6)}|${b.ne.latitude.toFixed(6)},${b.sw.longitude.toFixed(6)}|${b.sw.latitude.toFixed(6)},${b.sw.longitude.toFixed(6)}`]);
      if (s.center) q.push(['markers', `size:small|color:0x${col}|label:${String.fromCharCode(65 + i)}|${s.center.latitude.toFixed(6)},${s.center.longitude.toFixed(6)}`]);
    });
    return '/api/staticmap?' + q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  }
  function openSheet() {
    const f = selected, p = f.properties; const hasSolar = solar && !solar.error;
    const S = hasSolar ? Estimate.computeSolar(solar, sel, params.solar) : null;
    const Pn = Estimate.computePaint(p, null, sel, params.paint);
    const today = new Date().toLocaleDateString('ja-JP');
    const yearTxt = p.y ? `${p.y}年(築${NOW - p.y}年)` : '不明';
    const kv = rows => `<table>${rows.filter(r => r[1] != null && r[1] !== '-').map(r => `<tr><th style="width:40%">${r[0]}</th><td class="${r[2] || ''}">${r[1]}</td></tr>`).join('')}</table>`;
    let html = `<div class="head"><div><h1>屋根・外装 ご提案シート</h1><div>${lastAddress || '戸田市'}</div></div><div style="text-align:right">${params.company}<br>作成日 ${today}</div></div>
      <div class="grid2">
        <div><h2>建物概要</h2>${kv([['所在地', lastAddress || '-'], ['建築年', yearTxt], ['用途 / 構造', `${p.u || '-'} / ${p.str || '-'}`], ['階数 / 高さ', `${p.st != null ? p.st + '階' : '-'} / ${p.h != null ? p.h + ' m' : '-'}`], ['建築面積(輪郭)', `${num(p.fpa)} ㎡(${num(p.fpa / TSUBO)}坪)`], ['延床面積', p.tfa != null ? `${num(p.tfa)} ㎡` : null], ['外周長', `${num(p.per)} m`], ['敷地面積(概算・手計測)', measure.area > 0 ? `${num(measure.area)} ㎡(${num(measure.area / TSUBO)}坪)` : null]])}
        ${hasSolar ? `<h2>屋根の構成</h2><table><tr><th>面</th><th>方位</th><th>勾配</th><th>面積</th></tr>${S.segs.map(s => `<tr><td><b style="color:${SEG_COLORS[s.idx % 8]}">${s.label}</b></td><td>${s.dir}(${num(s.az, 0)}°)</td><td>${num(s.pitch, 0)}°</td><td class="num">${num(s.area)} ㎡</td></tr>`).join('')}<tr class="total"><td colspan="3">屋根実面積(勾配込み) / 投影面積</td><td class="num">${num(S.roofArea)} / ${num(S.groundArea)} ㎡</td></tr></table>` : ''}
        </div>
        <div><h2>航空写真・屋根図</h2><img src="${staticMapUrl(f, p.fpa < 180 ? 21 : 20, hasSolar)}" alt="航空写真"><div class="muted" style="font-size:9px">橙=建物輪郭(PLATEAU)${hasSolar ? ` / 色枠=屋根面(Solar API・画像品質 ${solar.imageryQuality})。Source: Includes solar data from Google.` : ''}</div></div>
      </div>`;
    const mmS = hasSolar ? solarMismatch(f, S) : null;
    if (mmS) html += `<div style="border:1px solid #d97706;background:#fffbeb;padding:3px 6px;margin:4px 0;font-size:10px">要確認: ${mmS}。屋根の数値は現地で確認してください。</div>`;
    if (hasSolar) html += `<h2>太陽光発電 概算${S.battery ? '(蓄電池あり)' : ''}<span style="font-weight:400;font-size:9px;margin-left:8px">Source: Includes solar data from Google</span></h2>
      <div class="kpi"><div>設置容量<b>${num(S.kw, 2)} kW</b>${S.panels}枚</div><div>年間発電量<b>${num(S.kwhAc, 0)} kWh</b></div><div>初期費用(概算)<b>${yen(S.cost)}</b>補助金 ${yen(S.subsidy)} 控除後</div><div>投資回収<b>${S.payback ? `約${S.payback}年` : `${params.solar.horizonYears}年超`}</b>${params.solar.horizonYears}年累計 ${yen(S.total)}</div></div>
      <div class="muted" style="font-size:9px">自家消費率 ${Math.round(S.selfRate * 100)}%・買電 ${params.solar.buyPrice}円/kWh・売電 ${params.solar.fitFirstPrice}円(${params.solar.fitFirstYears}年間)→${params.solar.fitAfterPrice}円・年劣化 ${params.solar.degradePerYear * 100}%・年間日照 ${num(S.sunHours, 0)}時間・CO₂削減 約${num(S.co2kg, 0)}kg/年</div>`;
    html += `<h2>屋根・外壁塗装 概算(屋根材: ${Pn.roofMaterial} / 塗料: ${Pn.wallGrade} / 勾配: ${Pn.pitchLabel})</h2>
      <table><tr><th>項目</th><th>数量・根拠</th><th style="text-align:right">金額</th></tr>
        <tr><td>足場(組立解体・メッシュシート・基本料)</td><td>(外周${num(Pn.per)}m+${params.paint.scaffoldOffset}m)×高さ${num(Pn.scH)}m = ${num(Pn.scArea, 0)}㎡ × ${yen(Pn.scaffoldUnit + params.paint.meshUnit)}${Pn.notes.length ? ' / ' + Pn.notes.join('・') : ''}</td><td class="num">${yen(Pn.scaffold)}</td></tr>
        ${Pn.roofScaffold ? `<tr><td>屋根足場</td><td>勾配${num(Pn.pitch, 0)}°</td><td class="num">${yen(Pn.roofScaffold)}</td></tr>` : ''}
        <tr><td>屋根塗装</td><td>${num(Pn.roofArea, 0)}㎡ × ${yen(Pn.roofUnit)}(${Pn.roofSrc}・PLATEAU)</td><td class="num">${yen(Pn.roof)}</td></tr>
        <tr><td>外壁塗装</td><td>外周${num(Pn.per)}m × 軒高${num(Pn.eave)}m × (1−開口${Math.round(params.paint.openingRate * 100)}%) = ${num(Pn.wallArea, 0)}㎡ × ${yen(Pn.wallUnit)}</td><td class="num">${yen(Pn.wall)}</td></tr>
        <tr><td>高圧洗浄</td><td>${num(Pn.roofArea + Pn.wallArea, 0)}㎡ × ${yen(params.paint.washUnit)}</td><td class="num">${yen(Pn.wash)}</td></tr>
        <tr><td>付帯部(雨樋・破風・軒天)</td><td>外周${num(Pn.per)}m × ${yen(params.paint.accessoryUnitPerM)}</td><td class="num">${yen(Pn.acc)}</td></tr>
        <tr><td>諸経費</td><td>小計 × ${Math.round(params.paint.overheadRate * 100)}%</td><td class="num">${yen(Pn.overhead)}</td></tr>
        <tr class="total"><td colspan="2">合計(税抜・概算)</td><td class="num">${yen(Pn.total)}</td></tr></table>
      <div class="note">本シートの面積・勾配・方位・発電量は航空写真と公開データ(国土交通省 PLATEAU、Google Solar API)からの推定値であり、現地調査により変動します。金額は当社標準単価による概算で、正式なお見積りは現地確認後に提示します。軒高は ${Pn.eaveSrc} から推定。塗装の数量は PLATEAU の建物輪郭から算出し、Solar API のデータは太陽光の項目にのみ使用しています。出典: Project PLATEAU(国土交通省) / Google Maps Platform(Source: Includes solar data from Google)。</div>`;
    $('sheet').innerHTML = html; $('sheetModal').classList.add('open');
  }
  $('sheetClose').onclick = () => $('sheetModal').classList.remove('open');
  $('sheetPrint').onclick = () => window.print();

  // ---------- 敷地計測 ----------
  $('measureBtn').onclick = () => { measure.on = !measure.on; $('measureBtn').classList.toggle('active', measure.on); map.data.setStyle(styleFn);
    if (measure.on) { map.setMapTypeId('hybrid'); if (map.getZoom() < 19) map.setZoom(20); $('hint').textContent = '敷地の角を順にクリック(もう一度「敷地計測」で終了・ダブルクリックでやり直し)'; $('hint').style.display = 'block'; }
    else { $('hint').style.display = 'none'; } };
  function addMeasurePoint(ll) {
    if (!measure.poly) { measure.poly = new google.maps.Polygon({ map, paths: [], strokeColor: '#00e676', strokeWeight: 2, fillColor: '#00e676', fillOpacity: .2, editable: true, clickable: false });
      measure.poly.getPath().addListener('set_at', updateMeasure); measure.poly.getPath().addListener('insert_at', updateMeasure); }
    measure.poly.getPath().push(ll); updateMeasure();
  }
  function updateMeasure() { const path = measure.poly.getPath(); measure.area = path.getLength() >= 3 ? google.maps.geometry.spherical.computeArea(path) : 0;
    $('hint').textContent = `敷地面積 概算 ${num(measure.area)} ㎡(${num(measure.area / TSUBO)}坪)`; $('hint').style.display = 'block'; if (selected) renderPanel(); }
  document.addEventListener('dblclick', () => { if (measure.on && measure.poly) { measure.poly.setMap(null); measure.poly = null; measure.area = 0; if (selected) renderPanel(); } });

  // ---------- 検索 ----------
  async function search() {
    const a = $('addr').value.trim(); if (!a) return;
    const r = await fetch('/api/geocode?address=' + encodeURIComponent(/戸田市|埼玉/.test(a) ? a : '埼玉県戸田市' + a)).then(r => r.json());
    if (!r.results || !r.results[0]) { alert('見つかりませんでした: ' + (r.status || '')); return; }
    const loc = r.results[0].geometry.location; map.setZoom(19); map.panTo(loc);
    if (searchMarker) searchMarker.setMap(null); searchMarker = new google.maps.Marker({ map, position: loc, title: r.results[0].formatted_address });
    google.maps.event.addListenerOnce(map, 'idle', () => {
      const hit = feats.find(f => f.bbox[0] <= loc.lng && loc.lng <= f.bbox[2] && f.bbox[1] <= loc.lat && loc.lat <= f.bbox[3] && pointInRing(loc, f.geometry.coordinates[0]));
      if (hit) { let df = null; map.data.forEach(x => { if (x.getProperty('id') === hit.properties.id) df = x; }); if (df) selectFeature(df); }
    });
  }
  function pointInRing(pt, ring) { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt.lat) !== (yj > pt.lat) && pt.lng < (xj - xi) * (pt.lat - yi) / (yj - yi) + xi) inside = !inside; } return inside; }
  $('searchBtn').onclick = search; $('addr').addEventListener('keydown', e => { if (e.key === 'Enter') search(); });

  // ---------- CSV ----------
  $('csvBtn').onclick = () => {
    const rows = [['建物ID', '建築年', '築年数', '用途', '構造', '階数', '高さm', '建築面積m2', '外周m', '緯度', '経度']];
    feats.filter(f => visibleIds.has(f.properties.id)).forEach(f => { const p = f.properties; rows.push([p.id, p.y || '', p.y ? NOW - p.y : '', p.u || '', p.str || '', p.st || '', p.h || '', p.fpa, p.per, f.center.lat.toFixed(6), f.center.lng.toFixed(6)]); });
    const csv = '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `toda_targets_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  };

  // ---------- boot ----------
  loadParams().then(() => {
    if (!window.BROWSER_KEY) { $('app').style.display = 'none'; $('nokey').style.display = 'block'; return; }
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(window.BROWSER_KEY)}&libraries=geometry&language=ja&region=JP&loading=async&callback=initMap`;
    s.async = true; document.head.appendChild(s);
  });
})();
