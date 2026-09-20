# 屋根提案シート(戸田市デモ)— PLATEAU × Google Solar API

Google Maps 上で戸田市の建物をクリックすると、築年数(PLATEAU)と屋根情報(Solar API)を表示し、
太陽光・屋根外壁塗装の概算を出して「1枚の提案シート(A4 PDF)」を生成する営業向けデモ。

## 起動

```bash
cp .env.example .env   # キーを書く(.env は git 管理外)
python3 server/server.py
```

→ http://localhost:5194 (Claude Code preview では `yane-teian`)

`.env` が空、または `MOCK_SOLAR=1` のときは Solar API を呼ばず疑似データで動く(地図表示だけはブラウザ用キー必須)。

## APIキーの扱い(漏えい対策)

| キー | 用途 | 置き場所 | Google側の制限 |
|---|---|---|---|
| `GOOGLE_MAPS_SERVER_KEY` | Solar API / Geocoding API / Maps Static API | `.env` のみ。サーバーが中継し、ブラウザに渡らない | API制限=上記3つ。1日の割り当て上限を設定 |
| `GOOGLE_MAPS_BROWSER_KEY` | Maps JavaScript API(地図表示) | `.env` → サーバーが HTML に注入 | API制限=Maps JavaScript API のみ。HTTPリファラ制限=`localhost:5194/*` と公開ドメイン |
| `GOOGLE_MAPS_API_KEY` | 上記2つを1本で済ませる場合 | `.env` | 両方の制限を満たすこと |

Solar/Geocoding/Static Maps の結果は `data/cache/` に保存され、同じ建物の再クリックは課金されない。

## 構成

```
server/server.py     Python 標準ライブラリのみの静的配信 + API 中継(/api/solar, /api/geocode, /api/revgeocode, /api/staticmap)
web/index.html       画面
web/app.js           地図・選択・パネル・提案シート・敷地計測・CSV
web/estimate.js      概算ロジック(太陽光 / 塗装 / 足場)。Node からも呼べる
web/params.json      単価・係数の既定値(画面の「単価設定」で上書き → localStorage)
scripts/citygml_to_geojson.py  PLATEAU CityGML → 建物輪郭 GeoJSON(建築年・用途・階数・高さ・構造・延床・建築面積・外周)
data/toda_buildings.geojson.gz 戸田市 28,871 棟(築年あり 18,388 / うち住宅 10,587)
```

## 機能

- 築年で色分け(耐震基準の目安 / 築年数)、築N年以上・用途で絞り込み。ズーム15以上で表示
- 建物クリック → PLATEAU 属性 + Solar API(屋根実面積・投影面積・面ごとの方位/勾配/面積・パネル最大枚数・日照)
- 太陽光概算: 枚数×パネル出力→kW、初期費用(−補助金)、発電量(DC→AC 0.85)、自家消費/売電(FIT 24円×4年→8.3円)で回収年数
- 塗装概算: 足場 (外周+8m)×(軒高+0.7m)×単価、屋根実面積×屋根材単価、外周×軒高×(1−開口率)×塗料単価、洗浄・付帯・諸経費
- 「提案シートを作成」→ A4 1枚(建物概要 / 航空写真+屋根図 / 屋根構成 / 太陽光 / 塗装)→ 印刷ダイアログで PDF 保存
- 敷地計測: 航空写真で角をクリック → 概算 ㎡・坪(建ぺい率の目安)
- CSV: 表示中の絞り込み結果を営業リストに出力

## データ再生成

```bash
# G空間情報センターの PLATEAU CityGML(v4) zip を指定
python3 scripts/citygml_to_geojson.py 11224_toda-shi_city_2022_citygml_4_op.zip data/toda_buildings.geojson
gzip -k data/toda_buildings.geojson
```

他市(埼玉県の建築年あり43市町)も同じ手順で変換できる。`web/app.js` の `TODA` 座標と検索の市名を変える。

## 制約

- 建築年は PLATEAU(都市計画基礎調査由来)。戸田市は不明が約36%。東京23区・さいたま市・川口市は建築年が公開されていない
- Solar API は航空写真からの推定。郊外は MEDIUM/BASE 品質か対象外の場合がある。`imageryQuality` を画面に表示
- 概算はすべて推定値。単価は業者の単価表に差し替える前提

## 出典

- Project PLATEAU(国土交通省)3D都市モデル 戸田市 2022: https://www.geospatial.jp/ckan/dataset/plateau-11224-toda-shi-2022 (商用利用可)
- Google Maps Platform(Solar API / Maps JavaScript / Geocoding / Static Maps)
