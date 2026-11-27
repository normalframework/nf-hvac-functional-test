// ECharts is vendored as an ES module (no CDN), the same build the Open-FDD NF app ships.
// Classic defer scripts run after this module in document order, so expose it once here.
import * as echarts from './vendor/echarts.esm.min.js';

window.echarts = echarts;
