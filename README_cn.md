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
* **不依赖**任何的第三方的网络服务，未联网也能使用
- 支持对各种代码格式文件的查看和编辑，就想你在本地用VSCode编辑代码一样
- 支持的编辑器主题：浅色主题、深色主题
- 支持字体大小的设置，同时提供通过`ctrl+鼠标滚轮`来调整字体大小的快捷方式进行设置
- 支持长代码行的自动折行，并通过`alt + z`来切换自动折行
- 支持从Markdown文档中编辑单独的代码块
- 支持内部链接的快速预览
- 支持通快捷图标按钮或命令来创建新的代码文件
- 支持对是否显示行号进行设置
- 支持缩进参考线设置
- 支持代码缩略图设置

## 如何支持不同的代码文件
默认支持的代码文件扩展名是 `ts, js, py, css, c, cpp, go, rs, java, lua, php`。你可以在插件的设置面板中配置要支持哪些文件扩展名
![image.png](https://github.com/sunxvming/obsidian-vscode-editor/blob/main/img/20231103103939.png)


## 支持的快捷键
大部分的快捷键和VS Code的快捷键保持一致，以下是一些支持的快捷键

| 分类         | 快捷键                 | 操作               |
| ------------ | ---------------------- | ------------------ |
| Ctrl         | `ctrl + c`             | 复制               |
|              | `ctrl + x`             | 剪切               |
|              | `ctrl + v`             | 粘贴               |
|              | `ctrl + s`             | 保存               |
|              | `ctrl + a`             | 全选               |
|              | `ctrl + f`             | 查找               |
|              | `ctrl + h`             | 替换               |
|              | `ctrl + z`             | 撤销               |
|              | `ctrl + y`             | 重做               |
|              | `ctrl + /`             | 增加/去除注释      |
|              | `ctrl + d`             | 复制当前行         |
|              | `ctrl + [`             | 减少缩进           |
|              | `ctrl + ]`             | 增加缩进           |
|              | `ctrl + ↑`             | 向上移动当前行     |
|              | `ctrl + ↓`             | 向下移动当前行     |
|              | `ctrl + ←`             | 按单词向左移动光标 |
|              | `ctrl + →`             | 按单词向右移动光标 |
|              | `ctrl + Backspace`     | 删除左边的单词     |
|              | `ctrl + Delete`        | 删除右边的单词     |
| Ctrl + Shift | `ctrl + shift + z`     | 重做               |
|              | `ctrl + shift + k`     | 删除当前行         |
|              | `ctrl + shift + [`     | 折叠代码块         |
|              | `ctrl + shift + ]`     | 展开代码块         |
|              | `ctrl + shift + enter` | 在上方插入一行     |
|              | `ctrl + enter`         | 在下方插入一行     |
| Alt          | `alt + z`              | 自动折行           |




## 使用截图
- **亮色主题**
![image.png](https://github.com/sunxvming/obsidian-vscode-editor/blob/main/img/20230921184929.png)

- **暗色主题**
![image.png](https://github.com/sunxvming/obsidian-vscode-editor/blob/main/img/20230921184840.png)

- **创建代码文件**
![image.png](https://github.com/sunxvming/obsidian-vscode-editor/blob/main/img/20230921185107.png)


## 代码块编辑的支持
 该插件还支持从编辑器中的任何Markdown文档中编辑单独的代码块。
 只需**右键单击**任何代码块，然后单击“**在VSCode Editor Plugin中编辑代码块**”。
 
 这将打开一个新的代码编辑窗口，你可以在其中编辑代码块，然后在关闭窗口时，代码块将自动同步回到您的文档中。
![GIF 2023-11-3 10-25-01.gif](https://github.com/sunxvming/obsidian-vscode-editor/blob/main/img/GIF%202023-11-3%2010-25-01.gif)
 


## 内部链接快速预览的支持
你可以在 Obsidian 中添加一个指向代码文件的内部链接，将鼠标悬停在链接上即可进行**快速预览**。
![GIF 2023-11-2 19-48-55.gif](https://github.com/sunxvming/obsidian-vscode-editor/blob/main/img/GIF%202023-11-2%2019-48-55.gif)

当插入内部链接时，默认代码文件不会出现在文件提示列表中。您需要开启“检测所有类型文件”的设置。
![image.png](https://github.com/sunxvming/obsidian-vscode-editor/blob/main/img/20231103104141.png)

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
