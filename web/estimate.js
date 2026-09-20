// 概算ロジック(太陽光・塗装・足場)。ブラウザと Node の両方から使う
(function (root) {
  const DIRS = ['北','北東','東','南東','南','南西','西','北西'];
  function dirName(az) { return DIRS[Math.round(((az % 360) + 360) % 360 / 45) % 8]; }
  function sunFactor(az) { // 南=1.0 東西=0.85 北=0.6 の簡易係数
    const d = Math.abs(((az - 180) % 360 + 540) % 360 - 180); // 南からの角度差 0..180
    return d <= 45 ? 1.0 : d <= 135 ? 0.85 : 0.6;
  }

  function computeSolar(solar, sel, P) {
    const sp = solar && solar.solarPotential; if (!sp) return null;
    const cfgs = sp.solarPanelConfigs || []; if (!cfgs.length) return null;
    const maxP = sp.maxArrayPanelsCount || cfgs[cfgs.length - 1].panelsCount;
    const want = Math.min(sel.panels || Math.min(maxP, P.defaultPanelsCap), maxP);
    let cfg = cfgs[0]; for (const c of cfgs) if (c.panelsCount <= want) cfg = c;
    const scale = P.panelWatt / (sp.panelCapacityWatts || 250);
    const kw = cfg.panelsCount * P.panelWatt / 1000;
    const kwhAc = cfg.yearlyEnergyDcKwh * scale * P.dcToAc;
    const self = sel.battery ? P.selfUseRateWithBattery : P.selfUseRate;
    const equip = Math.round(kw * P.pricePerKw) + (sel.battery ? P.batteryPrice : 0);
    const cost = Math.max(0, equip - P.subsidy);
    let cum = 0, payback = null; const years = [];
    for (let y = 1; y <= P.horizonYears; y++) {
      const gen = kwhAc * Math.pow(1 - P.degradePerYear, y - 1);
      const sell = y <= P.fitFirstYears ? P.fitFirstPrice : P.fitAfterPrice;
      const benefit = gen * (self * P.buyPrice + (1 - self) * sell);
      cum += benefit; years.push({ y, gen, sell, benefit, cum });
      if (payback === null && cum >= cost) payback = y;
    }
    const segs = (sp.roofSegmentStats || []).map((s, i) => ({
      idx: i, label: String.fromCharCode(65 + i), area: s.stats.areaMeters2, ground: s.stats.groundAreaMeters2,
      pitch: s.pitchDegrees || 0, az: s.azimuthDegrees || 0, dir: dirName(s.azimuthDegrees || 0), sun: sunFactor(s.azimuthDegrees || 0),
      sunHours: s.stats.sunshineQuantiles ? s.stats.sunshineQuantiles[5] : null, bbox: s.boundingBox, center: s.center,
    }));
    const southArea = segs.filter(s => s.sun >= 0.85).reduce((a, s) => a + s.area, 0);
    return {
      panels: cfg.panelsCount, maxPanels: maxP, kw, kwhAc, cost, equip, subsidy: P.subsidy, selfRate: self, payback, years,
      total: cum, firstYear: years[0].benefit, panelArea: cfg.panelsCount * (sp.panelHeightMeters || 1.65) * (sp.panelWidthMeters || 0.99),
      maxArea: sp.maxArrayAreaMeters2, roofArea: sp.wholeRoofStats && sp.wholeRoofStats.areaMeters2,
      groundArea: sp.wholeRoofStats && sp.wholeRoofStats.groundAreaMeters2, sunHours: sp.maxSunshineHoursPerYear,
      co2kg: Math.round(kwhAc / 1000 * (sp.carbonOffsetFactorKgPerMwh || 428)), segs, southArea, quality: solar.imageryQuality,
      imageryDate: solar.imageryDate, battery: !!sel.battery,
    };
  }

  function computePaint(props, solar, sel, P) {
    const per = props.per || 0, fpa = props.fpa || 0, st = props.st || null, h = props.h || null;
    const sp = solar && solar.solarPotential;
    const pitch = sp && sp.roofSegmentStats && sp.roofSegmentStats.length ? Math.max(...sp.roofSegmentStats.map(x => x.pitchDegrees || 0)) : 25;
    const notes = [];
    let eave, eaveSrc;
    if (st) { eave = st * P.floorHeight + P.baseHeight; eaveSrc = `地上${st}階 × ${P.floorHeight}m + 基礎${P.baseHeight}m`; }
    else if (h) { const rise = Math.sqrt(fpa) / 2 * Math.tan(pitch * Math.PI / 180); eave = Math.max(h - rise, 3.5); eaveSrc = `最高高さ${h}m − 屋根立上り${rise.toFixed(1)}m`; }
    else { eave = 6.5; eaveSrc = '既定値(2階建て相当)'; }
    const stories = st || Math.max(1, Math.round(eave / P.floorHeight));
    const scH = eave + P.scaffoldExtraHeight, scPer = per + P.scaffoldOffset, scArea = scPer * scH;
    const unit = P.scaffoldUnit + (stories >= 3 ? P.threeStoryExtraUnit : 0);
    if (stories >= 3) notes.push('3階建て以上のため足場単価を割増');
    let scaffold = scArea * unit + scArea * P.meshUnit + P.scaffoldBase;
    if (sel.narrow) { scaffold *= P.narrowFactor; notes.push('狭小地(隣地離れ60cm未満)割増'); }
    const roofScaffold = pitch >= P.roofScaffoldPitchDeg ? P.roofScaffoldCost : 0;
    if (roofScaffold) notes.push(`勾配${pitch.toFixed(0)}°(6寸以上)のため屋根足場を加算`);
    let roofArea, roofSrc;
    if (sp && sp.wholeRoofStats) { roofArea = sp.wholeRoofStats.areaMeters2; roofSrc = 'Solar API 実面積(勾配込み)'; }
    else { roofArea = fpa * P.roofAreaFallbackFactor; roofSrc = `建築面積 × ${P.roofAreaFallbackFactor}(推定)`; }
    const roofUnit = sel.roofMaterial in P.roofUnit ? P.roofUnit[sel.roofMaterial] : 3000;
    const roof = roofArea * roofUnit;
    const wallArea = per * eave * (1 - P.openingRate);
    const wallUnit = sel.wallGrade in P.wallUnit ? P.wallUnit[sel.wallGrade] : 2800;
    const wall = wallArea * wallUnit;
    const wash = (roofArea + wallArea) * P.washUnit;
    const acc = per * P.accessoryUnitPerM;
    const sub = scaffold + roofScaffold + roof + wall + wash + acc;
    const overhead = sub * P.overheadRate;
    return {
      per, fpa, stories, eave, eaveSrc, pitch, scPer, scH, scArea, scaffoldUnit: unit, scaffold, roofScaffold,
      roofArea, roofSrc, roofUnit, roof, wallArea, wallUnit, wall, wash, acc, sub, overhead, total: sub + overhead, notes,
      roofMaterial: sel.roofMaterial, wallGrade: sel.wallGrade,
    };
  }

  const api = { computeSolar, computePaint, dirName, sunFactor };
  if (typeof module !== 'undefined') module.exports = api; else root.Estimate = api;
})(typeof window !== 'undefined' ? window : globalThis);
