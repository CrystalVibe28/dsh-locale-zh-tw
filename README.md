# dsh-locale-zh-tw

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）網頁介面的 **正體中文（台灣，`zh-TW`）語言包**，以 DSH 用戶端插件形式提供，並附上可重現的建置流程與 GitHub Actions 自動翻譯。

- 語言選項：設定 → 一般 → 語言 → **正體中文**（切換即時生效，偏好持久化到 `locale.preference`）。
- 覆蓋 **75 個 locale 命名空間、4,108 條介面文案**：DSH 內建的 73 個命名空間，加上已安裝插件（`dsh-pet` 的 `pet.config`／`pet.chat`）。
- 插件名稱／描述（`LocalizedText`，271 個套件／子路徑插件）也一併轉成正體中文。
- 未收錄的簡體文字以 3,241 對字元對照表＋術語表即時轉換；英文與已是正體中文的文字不受影響。
- 缺譯或未來新增的文案會沿 `zh-TW → zh → en` fallback 鏈顯示，不會出現空白或 key。

## 安裝

這是標準 DSH bundle（`package.json` 內含 `dsh.bundle.patch` 與 `dsh.client`）。用 `plugin_manager` 指向本目錄安裝，或從本倉庫安裝：

```
plugin_manager install_bundle target=<本目錄絕對路徑>
plugin_manager install_bundle target=github:CrystalVibe28/dsh-locale-zh-tw
```

安裝後重新整理網頁，於「設定 → 一般 → 語言」選擇 **正體中文**。

## 翻譯怎麼來的

1. `tools/build.mjs` 讀取 DSH 的編譯後 client bundle（`lib/client.js`）與顯示中繼資料（`locale/*.json`，含 `locale/<子路徑>/`），以 `@babel/parser` **靜態解析**每個插件 `ctx.locale.register(...)` 註冊的簡體字典——不是正規表達式猜測。
2. 逐字串以 [OpenCC](https://github.com/BYVoid/OpenCC) `cn → twp` 轉換為正體中文／台灣標準用語。
3. 套用 38 條台灣用語校正規則，修正 OpenCC 無法消歧或台灣不常用的詞：`只`／`隻`、`並`／`併`、`帳號`、`權限`、`設定`、`核准`、`計畫`、`回覆`、`實例`、`回饋`、`存取`、`使用者`、`儲存庫`、`等級`、`外掛套件` 等。
4. 產生插件中繼資料對照表與字元 fallback 表；Client 端在 `zh-TW` 作用時以 `resolveText` 轉接器套用（卸載時還原）。
5. 品質閘門：placeholder 對齊、換行數一致、字典與中繼資料皆無殘留簡體字；報告寫入 `tools/out/qa-report.json`。
6. `tools/verify-client.mjs` 以 VM 載入產生的 bundle，對照真實 `LocaleRuntime` 的驗證／查找契約做煙霧測試（字典註冊、fallback、中繼資料轉換、卸載還原）。

## 建置模式

| 指令 | 用途 |
| --- | --- |
| `node tools/build.mjs` | 本機：讀取已安裝的 DSH 桌面版 `app.asar` 與目前 profile 已安裝的 client 插件；同時更新 `tools/dsh-packages.json`、`tools/plugins.json` 與 `tools/out/source-snapshot.json` |
| `node tools/build.mjs --source <node_modules>` | 從 npm 取得的 DSH 套件樹建置（CI 自動翻譯用） |
| `node tools/build.mjs --from-snapshot` | 只依已提交的來源快照重建（CI 驗證用；必須與已提交的 `lib/client.js` 完全一致） |

```bash
cd tools
pnpm install
node build.mjs          # 需要 macOS 上的 DSH 桌面版；或改用 --source / --from-snapshot
node verify-client.mjs
```

## GitHub Actions

- **`.github/workflows/ci.yml`**（push／PR）：從已提交的來源快照重建、跑煙霧測試，若 `lib/client.js` 與快照不一致就讓 CI 失敗。
> 注意：Auto-translate 會在 workflow 內先跑建置、品質閘門與煙霧測試，才建立／更新 PR。GitHub 對「由 `GITHUB_TOKEN` 建立的 PR」不會再次觸發 `pull_request` workflow，因此自動 PR 本身可能沒有額外的 CI 執行；合併後 main 的 CI 仍會完整驗證。Fork 本倉庫後，請在 **Settings → Actions → General** 開啟 **Allow GitHub Actions to create and approve pull requests**（本倉庫已開啟）。

- **`.github/workflows/translate.yml`**（每日 04:00 台北時間、可手動觸發）：
  1. `tools/fetch-dsh-source.mjs` 從公共 npm registry 下載 `tools/dsh-packages.json` 列出、且會被翻譯讀取的 DSH 套件（可指定 `next` 或精確版本）；
  2. `build.mjs --source` 重新產生翻譯並跑品質閘門與煙霧測試；
  3. 有差異時建立／更新 `auto/translate-<version>` 分支與 Pull Request，內容含 `lib/client.js`、版本清單與來源快照。

> 排程只在預設分支（`main`）生效；若倉庫連續 60 天沒有任何活動，GitHub 會暫停排程，需在 **Actions** 頁面按 **Enable workflow** 重新啟用。想立即補上新版本時，直接手動觸發：`gh workflow run translate.yml -f version=next`。

## 翻譯其他插件

支援範圍取決於該插件是否使用 DSH 的 locale service：

| 插件文字來源 | 支援方式 |
| --- | --- |
| `ctx.locale.register(ns, { zh, en, … })` 字典、`ctx.locale.bind(ns)` 取文案 | ✅ 建置時自動抽譯；本機已安裝插件會記錄在 `tools/plugins.json` 並在每次建置合併（目前包含 `dsh-pet`） |
| 插件名稱／描述（`LocalizedText`） | ✅ `resolveText` 轉接器轉換 |
| 完全硬編碼簡體字串、未使用 locale service | ❌ 架構上沒有可覆寫的接點；需該插件自行支援，或 fork 修改 |

安裝新的 locale-service 插件後，重新執行 `node tools/build.mjs && node tools/verify-client.mjs` 並重新整理頁面即可納入。

## 專案結構

```
lib/client.js          產生檔：語言定義、字典、中繼資料表、resolveText 轉接器
lib/index.js           Host 半部（只承載 bundle 資料列）
cordis.patch.yml       插入 locale-zh-tw 資料列
locale/*.json          插件自身顯示名稱（en／zh／zh-TW）
icon.svg               插件圖示
tools/build.mjs        建置＋台灣用語校正＋品質閘門
tools/extract-dicts.mjs  從 asar／node_modules 抽取字典與中繼資料
tools/fetch-dsh-source.mjs  從 npm registry 抓取 DSH 套件（CI 用）
tools/verify-client.mjs   離線煙霧測試
tools/dsh-packages.json   翻譯來源套件清單（名稱／版本／是否含 client／locale）
tools/plugins.json        已安裝第三方插件的字典層
tools/out/source-snapshot.json  已提交的來源快照（CI 驗證用）
```

## 已知限制

- 硬編碼字串（例如 dsh-pet 的右鍵選單、餘額面板）不經過 locale service，語言包無法翻譯。
- `resolveText` 轉接器是對目前 `LocaleRuntime` 介面的相容作法；若未來版本改名，語言與字典仍正常，但插件名稱／描述會回到簡體。
- 第三方插件字典以本機安裝當下抽取，插件升級後需重跑本機建置（或等上游更新）才能補齊新字串。

## 授權

程式碼與翻譯資料以 [MIT](LICENSE) 釋出。翻譯文字衍生自 DSH 隨附的簡體中文文案，DSH 亦以 MIT 授權釋出。
