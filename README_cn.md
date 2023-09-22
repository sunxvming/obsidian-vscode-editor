<h1 align="center">Obsidian VSCode Editor</h1>

<p align="center">
    <img alt="Release version" src="https://img.shields.io/github/v/release/sunxvming/obsidian-vscode-editor?style=for-the-badge">
    <img alt="Download count" src="https://img.shields.io/github/downloads/sunxvming/obsidian-vscode-editor/total?style=for-the-badge">
</p>

<p align="center">
    <span>一款 Obsidian 的第三方插件，提供对各种代码格式文件的查看和编辑功能。</span>
    <br/>
    <a href="/README_cn.md">简体中文</a>
    ·
    <a href="/README.md">English</a>
</p>


## 关于插件
Obsidian 默认不支持对各种代码文件的查看和编辑，而 Obsidian VSCode Editor 就是为了解决这个问题而生的。

它基于 [Monaco Editor](https://microsoft.github.io/monaco-editor/)（VSCode 的编辑器内核）开发，支持对各种代码格式文件的查看和编辑，包括但不限于：`C`、`C++`、`C#`、`CSS`、`Go`、`HTML`、`Java`、`JavaScript`、`JSON`、`Python`、`Ruby`、`Rust`、`Shell`、`XML`、`YAML`、`ini` 等。

你再也不用为了查看或编辑某个代码文件而打开另一个编辑器了，一切都在 Obsidian 中完成。

## 基本特性

- 支持对各种代码格式文件的查看和编辑，就想你在本地用VSCode编辑代码一样
- 支持对编辑器的主题颜色进行设置，包括浅色主题和深色主题
- 支持对编辑器的字体大小进行设置，同时提供通过`ctrl+鼠标滚轮`来调整字体大小的快捷方式进行设置
- 支持对是否显示行号进行设置
- 支持对是否显示缩进参考线进行设置
- 支持对是否显示代码缩略图进行设置
- 通快捷图标按钮或命令来创建新的代码文件

## 使用截图
- **亮色主题**
![image.png](https://sxm-upload.oss-cn-beijing.aliyuncs.com/imgs/20230921184929.png)

- **暗色主题**
![image.png](https://sxm-upload.oss-cn-beijing.aliyuncs.com/imgs/20230921184840.png)

- **创建代码文件**
![image.png](https://sxm-upload.oss-cn-beijing.aliyuncs.com/imgs/20230921185107.png)

- **编辑器设置面板**
![image.png](https://sxm-upload.oss-cn-beijing.aliyuncs.com/imgs/20230921190652.png)


## 安装

**从 Obsidian 的社区插件来安装**:
1. 打开设置 > 第三方插件
2. 关闭”安全模式“
3. 点击”浏览“按钮来查看第三方插件市场
4. 输入搜索：“VSCode Editor”
5. 点击“安装”按钮
6. 一旦安装成功，先关闭当前社区插件窗口，然后在已安装插件列表下激活刚安装的插件

**手动安装**:
1. 进入最新版本的github下载页面 [latest release](https://github.com/sunxvming/obsidian-vscode-editor/releases/latest)
2. 下载 `obsidian-vscode-editor-x.y.z.zip` 文件,其中 `x.y.z` 是版本号
3. 解压并提取 obsidian-vscode-editor 文件夹，然后放到你 Obsidian 库中的插件目录中 `<库>/.obsidian/plugins/` (注意: `.obsidian` 文件夹可能被隐藏了，你需要先将该文件夹展示出来)
4. 打开设置 > 第三方插件，重新加载和激活该插件

## 联系和反馈

如果你在使用该插件过程中，遇到各种问题、或有什么好的建议，欢迎在 [GitHub issues](https://github.com/sunxvming/obsidian-vscode-editor/issues) 中提出。
