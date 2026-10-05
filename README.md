# VectorLite

VectorLite 是一个从零开始的轻量 SVG 矢量编辑器原型，面向常用的 Illustrator 子集：图形绘制、选择变换、基础文字、嵌套树状图层、撤销重做和 SVG/PNG 导出。

SVG 导入会递归处理嵌套分组，读取 `viewBox`、`text/tspan` 的逐行坐标、分组变换和 `data:image/*` 内嵌图片；图层面板保留分组父子关系，并支持折叠、分组显隐和锁定。保存 SVG 时会保留分组顺序、显隐状态和锁定状态，因此可以打开由排版工具导出的复杂菜单类 SVG，而不再只支持根层的简单图形。

## 运行

直接双击 `index.html` 即可使用，也可以在当前目录运行：

```powershell
python -m http.server 4173
```

然后打开 <http://localhost:4173>。

## 当前格式边界

网页原型以 SVG 作为独立工作格式。原生 `.ai` 读写需要 Electron 桌面版调用本机 Illustrator 的脚本/自动化桥接；网页模式会拒绝把 `.ai` 当成 SVG 处理，并提示用户使用桥接版。

## 兼容性路线

1. 用真实 Illustrator 文件建立样本集。
2. 对矩形、椭圆、直线、基础路径、文字、图层和常用外观属性做结构与像素对比。
3. 在 Electron 封装阶段加入 Illustrator JSX/Windows 自动化桥接。
4. 对未支持的 Illustrator 专有对象生成明确的兼容性报告，不静默丢失。

桥接脚本位于 `bridge/illustrator-bridge.jsx`，当前网页模式不会自动调用它。
