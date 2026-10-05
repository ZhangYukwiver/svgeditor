# Illustrator 桥接

`illustrator-bridge.jsx` 让桌面宿主把格式解析和保存交给本机 Illustrator，避免自行逆向实现私有 `.ai` 格式。

桥接脚本读取以下环境变量：

- `VECTORLITE_BRIDGE_COMMAND`：`report`、`open`、`export-svg` 或 `save-ai`
- `VECTORLITE_INPUT`：需要打开的 `.ai`/`.svg` 路径（`open` 时使用）
- `VECTORLITE_OUTPUT`：输出报告、SVG 或 AI 的路径

当前网页原型不会执行 JSX。Electron 主进程接入时，应通过 Illustrator 的脚本入口运行该文件，并等待 `VECTORLITE_OUTPUT` 出现后读取结果。

桥接模式的兼容性来源是 Illustrator 自己的解析器和保存器；这意味着用户电脑需要安装 Illustrator。脚本输出的是结构报告或 Illustrator 原生文件，不代表网页编辑器已经支持所有专有对象。
