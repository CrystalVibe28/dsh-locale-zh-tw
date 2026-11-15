# dsh-locale-zh-tw

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）網頁介面的 **正體中文（台灣，`zh-TW`）語言包**，以 DSH 用戶端插件形式提供，並附上可重現的建置流程與 GitHub Actions 自動翻譯。

- 語言選項：設定 → 一般 → 語言 → **正體中文**（切換即時生效，偏好持久化到 `locale.preference`）。
- 覆蓋 **75 個 locale 命名空間、4,421 條介面文案**：DSH 內建的 73 個命名空間，加上已安裝插件（`dsh-pet` 的 `pet.config`／`pet.chat`）。
- 插件名稱／描述（`LocalizedText`，530 條顯示文案，轉出 515 條）也一併轉成正體中文。
- 未收錄的簡體文字以 3,241 對字元對照表＋術語表即時轉換；英文與已是正體中文的文字不受影響。
- 缺譯或未來新增的文案會沿 `zh-TW → zh → en` fallback 鏈顯示，不會出現空白或 key。

## 安裝

這是標準 DSH bundle（`package.json` 內含 `dsh.bundle.patch` 與 `dsh.client`），**直接從 GitHub 安裝即可，不需要 clone**：

1. 開啟 DSH 的 **外掛 → 安裝**，貼上倉庫網址：

   ```
   https://github.com/CrystalVibe28/dsh-locale-zh-tw
   ```

   等效於 `github:CrystalVibe28/dsh-locale-zh-tw`：pnpm 會抓 `main` 分支的 tarball，並在 `~/.dsh/profiles/<profile>/pnpm-lock.yaml` 鎖定當時的 commit。
2. 安裝後重新整理網頁，於 **設定 → 一般 → 語言** 選擇 **正體中文**。

發佈到 npm 後，也可以改用 registry 版本安裝，這樣 DSH 才會顯示「版本」清單與更新按鈕：

```
@crystalvibe28/dsh-locale-zh-tw
```

開發迭代時改用 `link:` 指向本機目錄，改完重跑建置即生效：

```bash
plugin_manager install_bundle target=link:/absolute/path/to/dsh-locale-zh-tw
```

> 從 GitHub 安裝的是**某個 commit 的快照副本**（放在 `~/.dsh/profiles/<profile>/node_modules/@crystalvibe28/dsh-locale-zh-tw`），本機改了原始碼不會自動反映。介面會以 `already-installed` 拒絕重複安裝，因此更新方式是**先移除外掛、再貼網址重新安裝**（或直接對 profile 執行 `pnpm add github:CrystalVibe28/dsh-locale-zh-tw`，會重新解析 `main` 的最新 commit）。Auto-translate 的 PR 合併後，同樣要更新一次安裝才會在介面生效。

**為什麼 GitHub 安裝不會出現「更新」**：DSH 的更新偵測只查 npm registry 的 semver 清單（`semver.gt` 比對已安裝版本），而且「版本」區塊只對以 registry 安裝的外掛顯示；Git 來源的外掛沒有版本清單，只能由市集索引提供釘死 commit 的 spec 來更新。因此要讓 DSH 自動看到新版本，必須安裝 npm registry 版本（見下一節）。

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

- **`.github/workflows/ci.yml`**（push／PR／可手動指定分支）：從已提交的來源快照重建、跑煙霧測試，若 `lib/client.js` 與快照不一致就讓 CI 失敗。
> 注意：由 `GITHUB_TOKEN` 建立的 PR，GitHub 會建立對應的 `pull_request` 執行，但拒絕實際執行（0 個 job、直接標記失敗），因此自動 PR 上那個紅色 ✗ 無法產生任何紀錄。Auto-translate 會在推送分支後改以 `gh workflow run ci.yml --ref <branch>` 觸發一次真正的 CI，結果以該次執行為準。Fork 本倉庫後，請在 **Settings → Actions → General** 開啟 **Allow GitHub Actions to create and approve pull requests**（本倉庫已開啟）。

- **`.github/workflows/translate.yml`**（每日 04:00 台北時間、可手動觸發）：
  1. `tools/fetch-dsh-source.mjs` 從公共 npm registry 下載 `tools/dsh-packages.json` 列出、且會被翻譯讀取的 DSH 套件（可指定 `next` 或精確版本）；
  2. `build.mjs --source` 重新產生翻譯並跑品質閘門與煙霧測試；
  3. **翻譯內容有差異時把 `package.json` 的 patch 版號加一**（例如 `1.2.0` → `1.2.1`）；
  4. 建立／更新 `auto/translate-<version>` 分支與 Pull Request，內容含 `lib/client.js`、版本清單、來源快照與新的版號；
  5. 對該分支觸發真正的 CI 驗證。

- **`.github/workflows/release.yml`**（push 到 `main`、可手動觸發）：讀取 `package.json` 版號，若 npm registry 還沒有這個版本就 `pnpm publish`。**未設定 `NPM_TOKEN` secret 時只會留一則 notice 並略過**，不會讓 CI 失敗。

> 排程只在預設分支（`main`）生效；若倉庫連續 60 天沒有任何活動，GitHub 會暫停排程，需在 **Actions** 頁面按 **Enable workflow** 重新啟用。想立即補上新版本時，直接手動觸發：`gh workflow run translate.yml -f version=next`（`version` 可填 `next`、`latest` 或精確 semver）。

## 版號與更新偵測

DSH（0.2.2-rc.3）的更新偵測**只看 npm registry**：

- `dsh-plugin-manager` 以 `pnpm view <name> versions` 取得已發佈版本，用 `semver.gt` 篩出比已安裝版本新的版本（`src/versions.ts` 的 `newerVersions`）。
- 外掛頁的「版本」區塊只在該 bundle 被判定為 `update: 'registry'` 時渲染；以 Git 安裝的 bundle 沒有版本清單，只會由市集（Discover）索引提供釘死 commit 的 spec 來更新（`src/client/versions.tsx` 的 `VersionSection`）。

因此本專案的做法是：

1. **每次翻譯內容變動就遞增 patch 版號**（由 `translate.yml` 完成），版號是 DSH 判斷「有沒有更新」的唯一依據。
2. **PR 合併後由 `release.yml` 發佈到 npm**。發佈預設為關閉，需同時設定兩個條件才會啟用：
   - 倉庫變數 `NPM_PUBLISH=true`（Settings → Secrets and variables → Actions → Variables）
   - `NPM_TOKEN` secret 所屬的 npm 帳號擁有 `@crystalvibe28` 這個 scope（可在 npm 建立同名組織，或把 `package.json`、`cordis.patch.yml` 與 README 的 scope 改成你擁有的名稱）

   目前 `@crystalvibe28` scope 尚未開通，直接發佈會得到 `E404`（npm 對沒有權限的 scope 會回 404），因此先保持 opt-in 關閉，等 scope 準備好再打開。
3. 使用者以 **npm registry 版本**（`@crystalvibe28/dsh-locale-zh-tw`）安裝後，外掛頁的「版本」區塊就會列出較新版本並提供更新；以 GitHub 網址安裝者仍需先移除再重裝。

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
cordis.patch.yml       插入 dsh-locale-zh-tw 資料列
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
