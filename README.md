# 西宝客专 / XibaoView

西宝客运专线（徐兰高速铁路西宝段）手机地图：宝鸡南 ↔ 西安北。

这是独立应用，不是宝成慢车（baochengview）的改版。线路与车站来自 OpenStreetMap 的徐兰高速线西宝段，不含陇海线、宝成线，也不含宝鸡站。

## 功能

- **地图**：全线与五站，搜索车站，一键适配全线
- **站序**：按正线公里标排站。竖屏站名在刻度右侧，横屏（宽 > 高）站名在刻度下方
- **海拔**：沿铁路线折线采样（不是站间直线）。「海拔」细线、「起伏」更平滑；车站点落在平滑曲线上；相邻坡度上限 30‰
- **河流**：线路跨越或伴行的河流，中文名，同一套公里标。靠近车站的河流落在该站公里标上
- **停留**：仅在距站 400 m 内开始停留；距该站超过 800 m 才结束并写入本机。停留中显示「正在停」，站间不算停留
- **定位**：顶栏经纬度与时间；12 秒超时；定位中可取消；watch + 短轮询；`maximumAge: 0`

## 车站（宝鸡南 = 0 km，沿 OSM 正线折线计公里）

| 站序 | 站名 | 公里标 | OSM |
|------|------|--------|-----|
| 1 | 宝鸡南 | 0.0 | [7276282773](https://www.openstreetmap.org/node/7276282773) |
| 2 | 岐山 | 36.3 | [2820611675](https://www.openstreetmap.org/node/2820611675) |
| 3 | 杨陵南 | 77.2 | [2691462623](https://www.openstreetmap.org/node/2691462623) |
| 4 | 咸阳西（曾用名咸阳秦都） | 136.7 | [2726644052](https://www.openstreetmap.org/node/2726644052) |
| 5 | 西安北 | 162.5 | [4185074601](https://www.openstreetmap.org/node/4185074601) |

全线约 162.5 km（OSM 徐兰高速线折线，裁到两端车站）。

## 运行

```bash
npm install
npm run dev
```

开发服务器默认 `http://127.0.0.1:4731`。

```bash
npm run build
npm run preview
```

重新生成线路 / 海拔 / 河流数据（需要已有 OSM 缓存或自行准备 `XIBAO_OSM_RAW`）：

```bash
npm run build:data
```

## 数据

- 线路：OpenStreetMap `name=徐兰高速线` 高速正线，宝鸡南→西安北
- 车站：OSM `railway=station` 节点（见上表）
- 海拔：Open-Meteo Elevation API（SRTM 90 m），沿正线每 1 km 采样
- 河流：OSM `waterway=river` 中文名
- 底图：CARTO Dark，失败时回退 OSM.org。没有 Esri

地图数据 © OpenStreetMap 贡献者，[ODbL](https://opendatacommons.org/licenses/odbl/)。
