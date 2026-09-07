# Listen & Learn Local

一个在 Windows 本地运行的英语录音学习工具。它使用 `faster-whisper` 转录 m4a、mp3、wav 等录音，并把播放、逐字稿修改、精听标记、发音练习和口语回应放在同一个网页里。

录音和学习数据只保存在自己的电脑上，不调用付费 API，也不上传到远程服务。

## 直接在线使用

打开 **[Listen & Learn 网页版](https://tylerzhang130666.github.io/local-english-audio-learning/)**，选择电脑里的录音即可。网页端使用 Transformers.js 和 whisper-tiny.en 在浏览器内转录；模型首次使用时下载并缓存，录音内容不会上传。

网页版适合免安装体验和较短录音。40 分钟以上录音可能耗时较长并占用较多浏览器内存；需要更高准确率和稳定处理长录音时，建议使用下面的 Windows 本地版。

## 功能

- 可拖动的长录音进度条、前后 5 秒、0.75x / 1x / 1.25x 和音量增强
- 播放时自动定位并高亮当前逐字稿；点击句子跳到对应时间
- 直接修改识别文本，添加笔记、收藏、待学习和录音位置标记
- 把“听不懂”的句子筛出来，逐句循环练习
- 每句记录 Meaning、My Response、不会说和已掌握状态
- 建议重读词、弱读词和可能的连读位置，均可手动修改
- 点击单词离线查看美式 IPA、音节和重音，并录制自己的读音进行对比
- 导出 Markdown、TXT 和 SRT

## Windows 快速开始

需要 Windows 10/11、Python 3.11–3.13 和网络连接用于首次安装。

1. 点击 GitHub 页面右上方 `Code → Download ZIP`，解压到普通文件夹。
2. 双击 `setup.bat`。它会创建独立 Python 环境、安装依赖并下载 `small.en` 模型。
3. 将自己的录音放入 `audio` 文件夹。
4. 双击 `start.bat`，浏览器会打开 <http://127.0.0.1:8765/>。
5. 选择录音并点击“开始英文转录”。保持启动窗口开启。

也可以使用 Git：

```powershell
git clone https://github.com/TylerZhang130666/local-english-audio-learning.git
cd local-english-audio-learning
.\setup.bat
.\start.bat
```

第一次安装和下载模型可能需要数分钟。之后可以离线使用。CPU 转录 40–50 分钟的录音也需要一定时间，具体速度取决于电脑配置。

## 隐私和数据

- `audio/` 中的个人录音和 `data/` 中的逐字稿默认被 Git 忽略，不会随普通提交上传。
- 逐字稿、修改、句子标记和学习笔记保存在 `data/*.json`。
- 发音练习录音保存在当前浏览器的 IndexedDB；清理网站数据会删除这些录音。
- 服务只监听 `127.0.0.1`，不能从局域网或互联网访问。
- GitHub Pages 不能直接运行这个项目，因为本地转录需要 Python 后端和 Whisper 模型。使用者需要下载后在自己的电脑上启动。

提交公开仓库前仍应运行 `git status`，确认没有手动强制加入私人文件。

## 发音功能的范围

IPA 数据来自 Carnegie Mellon University 的 [CMU Pronouncing Dictionary](https://github.com/cmusphinx/cmudict)。重读、弱读和连读目前是依据文字生成的学习建议，不是对录音的声学测量。专业缩写、人名和未收录词会显示“未收录”；工具不会自动编造音标，也不生成发音准确率分数。

## 测试

仓库附带公开的 JFK 英文测试音频，可以先用它体验。安装完成后运行：

```powershell
.\.venv\Scripts\python.exe -m unittest test_app -v
```

更详细的操作和故障排查见 [使用说明](./使用说明.md)。

## License

程序代码以 [MIT License](./LICENSE) 发布。CMUdict 适用其自己的 [BSD-style license](./resources/CMUdict-LICENSE.txt)。公开测试音频来源见使用说明中的链接。
