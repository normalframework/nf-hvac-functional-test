// Globals shared between the classic <script> files of static/index.html that a script does not declare itself.
declare const echarts: any; // vendored ECharts, exposed by echarts-global.js
interface Window { echarts: any; }
