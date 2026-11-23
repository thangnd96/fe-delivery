# fe-delivery

Plugin Claude Code để giao việc Front-End có kiểm soát. Từ một Jira key, một Figma URL hoặc một yêu cầu thường, plugin dẫn qua các bước:

1. Intake cách ly.
2. Phân loại hai trục: tier và risk.
3. Chạy chuỗi Spec Kit tương xứng với tier.
4. Human gate.
5. Kiểm chứng có bằng chứng.
6. Report.

Các luật không có ngoại lệ được **hook cưỡng chế**, không chỉ ghi trong prompt.

Các quyết định thiết kế (ADR, kèm nguồn: tài liệu Claude Code, Spec Kit, Anthropic Engineering, OWASP, Meta "Agents Rule of Two") được duy trì trong bộ blueprint kiến trúc đi kèm.

## Thành phần

| Thành phần | Vai trò |
|---|---|
| Skill `fe-deliver` | Conductor, và là skill duy nhất model tự gọi được. Các tier nằm trong `references/`. |
| Skill `/fe-delivery:fe-setup`, `/fe-delivery:fe-uninstall`, `/fe-delivery:speckit-upgrade` | Cài vào repo; gỡ sạch theo manifest; nâng cấp Spec Kit có review. Chỉ chạy khi người dùng gọi. |
| Agent `fe-intake`, `fe-verifier`, `fe-reviewer` | Intake chỉ đọc; kiểm chứng L2/L3; review độc lập. |
| `hooks/hooks.json` → `scripts/hook.mjs` | Guard: U1 · S · G0–G10 · SA · P1–P4 · T1. |
| `scripts/fe.mjs` | CLI cho conductor: `run`, `intake`, `classify`, `gate`, `verify`, `evidence`, `report`, `graph ensure\|status`, `git-hooks`, `doctor`, `install`, `uninstall`. |
| `scripts/graph-refresh.mjs` | Refresh graph ở nền sau lệnh git đổi cây làm việc (do P4 khởi chạy). |
| `schemas/` | profile, intake, classification, evidence, claim. |
| `compat/speckit.json` | Phiên bản Spec Kit, pilothify và Claude Code mà plugin đã kiểm. |

Script dùng Node.js ≥ 18 và không có dependency nào. Máy dev FE luôn có sẵn Node.

## Luật của guard

| Rule | Hook | Nội dung |
|---|---|---|
| U1 | UserPromptSubmit | Bắt Jira key (chỉ các project key trong profile), Figma URL và token `[tier:…]`, `[stop-after:…]`. Token `[no-run]` cho phép bỏ qua workflow. |
| G0 | PreToolUse | Prompt có Jira/Figma thì chưa được sửa file hay chạy Spec Kit cho tới khi có run. |
| G1 | PreToolUse | Thứ tự skill `speckit-*` suy ra từ artifact trên đĩa và approval đã ghi. |
| G2 | PreToolUse | Sửa source cần gate đã được duyệt; tier Spec Kit cần có `tasks.md` trước. |
| G3 | PreToolUse | File thuộc vùng rủi ro mà classification chưa gắn cờ → phải phân loại lại. |
| G4 | PreToolUse | Vượt ngân sách diff của tier → phải phân loại lại. |
| G5 | PreToolUse | Chặn `claude` lồng nhau, `specify workflow run/resume`, cờ `--dangerously-skip-permissions`, và mọi truy cập hook zone. |
| G6 | PreToolUse | Câu hỏi gate phải đúng hai lựa chọn Approve/Reject và không được điền sẵn câu trả lời. |
| G7 | PreToolUse | Run shadow (dừng sau bước lập plan) không được sửa mã nguồn sản phẩm và không được gọi `speckit-implement`, `speckit-converge`, `speckit-bug-fix`, `speckit-bug-test`. Run là shadow khi profile đặt `rollout.mode = "shadow"`, khi người dùng viết `[stop-after:plan]`, hoặc khi chạy `fe run start --stop-after plan`. Nếu mã nguồn bị đổi qua đường khác (ví dụ Bash) thì run không kết thúc được cho tới khi hoàn tác. |
| G8 | PreToolUse | Khi đang giao việc, không được sửa `.fe-delivery/profile.json` và install manifest, bằng Edit/Write hay bằng Bash. Run luôn dùng bản profile chụp lúc bắt đầu, nên sửa hoặc xoá file giữa chừng cũng không nới được luật. |
| G9 | PreToolUse | Graph trước: trong run, `fe-intake` chưa được tìm code bằng `grep`/`rg`/`find`/Grep/Glob khi run chưa có `pilothify query`/`explain` nào. Mỗi lần query được ghi lại cho report và cho `fe intake save`. |
| G10 | PreToolUse | `fe-reviewer` chỉ bắt đầu khi graph khớp cây làm việc, để `pilothify affected` thấy code mới (`fe graph ensure`). |
| SA | PreToolUse | `fe-intake`/`fe-reviewer` chỉ đọc; `fe-verifier` không sửa file; subagent không được gọi MCP ghi. |
| P1 | PostToolUse | Ghi approval từ câu trả lời của người. Chỉ đúng chữ "Approve" mới được tính. |
| P2 | PostToolUse | Tính lại diff từ git; `last_edit_at` chỉ đổi khi nội dung file đổi. |
| P3 | PostToolUse | Chỉ tin trailer `FE_*` khi lệnh là một lệnh `fe` trần (không nối lệnh): bắt đầu run, ghi evidence, kết thúc run. Evidence chỉ được nhận khi lệnh check trùng với lệnh trong profile chụp lúc bắt đầu run. |
| P4 | PostToolUse | Lệnh git đổi cây làm việc (`checkout`, `switch`, `pull`, `merge`, `rebase`, `reset`, `stash`, `restore`, `cherry-pick`, `revert`) khởi chạy `pilothify update` ở nền. |
| T1 | Stop | Run có thay đổi mà thiếu điều kiện → chặn một lần cho mỗi lượt sửa. Mỗi check phải có lần chạy **pass** sau lần sửa cuối; check fail cũng được ghi lại, nhưng ghi lại là bằng chứng của việc fail. |

G9, G10 và bước kiểm graph của `fe intake save` theo `graph.enforce` trong profile: `warn` (mặc định) cho đi tiếp, cảnh báo ở console và ghi vào report; `block` từ chối; `off` bỏ qua.

## Graph luôn khớp code

Graph khớp với một **cây làm việc**, không chỉ với một commit. fe ghi dấu `{ head, fingerprint }` sau mỗi lần refresh thành công. `fingerprint` là hash của `git status`, `git diff HEAD` và nội dung các file chưa track. Fingerprint không tính:
- thư mục `pilothify-out/`;
- các file mà template settings cấm đọc, nên sandbox của Claude Code không đọc được: `.env`, `.env.*` (kể cả `.env.example`), `*.pem` và `*.key`, ở mọi cấp thư mục. pilothify cũng không đưa các file này vào graph.
- path mà process không đọc được (EPERM/EACCES) do một luật cấm khác. Đó có thể là:
  - file đang track mà git báo nhầm là đã xoá;
  - file chưa track mà sandbox chỉ cho thấy tên;
  - thư mục không liệt kê được, nếu trong đó có file đang track.

  Dấu ghi lại các path này ở trường `unreadable`, và phía kiểm tra cũng bỏ qua đúng các path đó.

Với các luật cấm của template, dấu tính trong sandbox (lệnh `fe` do agent chạy) luôn khớp với dấu tính ngoài sandbox (hook của fe và lần refresh nền `graph-refresh.mjs`).

Nếu team tự thêm luật cấm đọc, còn ba giới hạn:
- Dưới luật đó có file chưa track hoặc file đã sửa: sau mỗi lần refresh nền, lần kiểm đầu tiên trong sandbox sẽ refresh thêm một lần.
- Hai trường hợp vẫn báo lệch như 0.4.2:
  - file chưa track trong một thư mục mà sandbox không liệt kê được, khi trong thư mục đó không có file đang track nào bị ẩn;
  - file mới hoặc file `git mv` đã stage vào path bị cấm theo từng file.
- Hơn 1.000 mục không đọc được: graph luôn bị coi là lệch, cho tới khi số path bị ẩn giảm xuống.

Khi git lỗi, hoặc vượt giới hạn 1.000 mục, fingerprint là `null` và graph bị coi là lệch. Lý do đầy đủ chỉ hiện khi chạy `fe graph status` trong sandbox. Ngoài sandbox, G10 chỉ báo là cây làm việc đã đổi kể từ lần refresh cuối. Mọi chỗ kiểm độ mới đều so cả hai phần. Graph thiếu `built_at_commit`, hoặc chưa có dấu, luôn bị coi là lệch.

| Thời điểm | Ai lo | Làm gì |
|---|---|---|
| Commit, đổi nhánh, merge, rebase (cả khi dev tự làm ngoài agent) | git hook của pilothify, cài bằng `fe git-hooks install` (mỗi clone một lần) | dựng lại ở nền |
| Agent chạy lệnh git đổi cây làm việc, kể cả `stash`/`reset`/`restore` | P4 | `pilothify update` ở nền |
| `fe run start` | fe | chờ khoá, rồi **dựng lại toàn bộ** (`pilothify update --full`) |
| `fe intake save`, `fe classify`, `fe verify` (trước fe-reviewer), `fe run end` | fe | chờ khoá; lệch dấu thì `pilothify update` |
| Sửa code trong task | không làm gì | |

- **Chờ khoá:** trước khi đọc graph, fe chờ `pilothify-out/.rebuild.lock` được nhả (mặc định tối đa 100 s, dưới timeout 2 phút của một lệnh Bash; đặt lại bằng `FE_DELIVERY_GRAPH_LOCK_TIMEOUT_MS`). Hết giờ thì báo rõ PID đang giữ khoá.
- **Từ chối ghi là lỗi:** khi pilothify từ chối ghi graph (guard chống co graph) hoặc thoát mã khác 0, `fe graph ensure` thoát mã 1 và dấu cũ được giữ nguyên.
- **Linked worktree:** hook của pilothify bỏ qua việc dựng lại ở đây; các điểm kiểm của fe vẫn tự refresh.
- **pilothify 0.1.5:** không có `--full` nên fe dùng `update --force`; `git-hooks install` cần 0.1.6.
- `fe graph status [--json]` cho biết graph còn khớp không, ai đang giữ khoá, và trạng thái git hook. Report có mục `## Graph`: số lần refresh, số query của intake theo exit code (0/3/4), có grep fallback không, và graph so với cây làm việc lúc viết report.

## State nằm ngoài repo

- **Agent zone** `~/.fe-delivery/agent/`: CLI `fe` ghi vào đây, gồm cả dấu độ mới của graph theo từng checkout, nhật ký graph của run và bản ghi git hook do fe cài. Settings cho phép sandbox ghi vào thư mục này.
- **Hook zone** `~/.fe-delivery/hook/`: chỉ hook ghi, gồm active run, approval, evidence đo được, diff, events. Bash bị chặn truy cập ở hai lớp: rule G5 và sandbox.

Khi tắt sandbox, việc bảo vệ hook zone chỉ còn ở mức best-effort; `fe doctor` sẽ cảnh báo.

## Cài đặt

Plugin được phát hành qua `piloth-marketplace`:

```text
/plugin marketplace add thangnd96/piloth
/plugin install fe-delivery@piloth-marketplace
```

Sau đó mở repo FE và chạy `/fe-delivery:fe-setup`. pilothify chỉ cài từ GitHub và phải pin tag (xem `compat/speckit.json`).

- **Chế độ chạy:** `rollout.mode` mặc định là `full`. Đặt `shadow` nếu muốn thử: mọi run chỉ phân loại và lập plan, không sửa code. Mỗi team tự chọn.
- **Jira:** profile chỉ cần project key để nhận ra ticket trong prompt. Không cần cấu hình Jira site; plugin dùng kết nối Atlassian mà máy đang có.
- **Chỉ nhắc, không can thiệp:** `fe install`, `fe doctor` và đầu phiên chỉ in một dòng nhắc khi cần, và không sửa cấu hình của consumer. Hai trường hợp nhắc là:
  - file của fe-delivery bị repo gitignore, nên không đến được đồng đội;
  - `.mcp.json` còn dùng endpoint Atlassian v1 đã bị deprecate.

## Gỡ cài đặt

`fe install`, do `fe-setup` gọi, ghi mọi thay đổi trong repo vào `.fe-delivery/install-manifest.json`. `fe uninstall` chỉ đảo ngược đúng những gì có trong manifest:

- **File chưa bị sửa sau khi cài:** khôi phục y nguyên từng byte.
- **File đã bị sửa:** chỉ gỡ entry hoặc khối do fe-delivery thêm, phần của team giữ nguyên.
- **Không bao giờ đụng tới:** `src/`, `specs/`, constitution của Spec Kit mà team đã viết, worktree, branch, lịch sử commit.
- **`--speckit`** (chỉ khi `fe-setup` đã cài Spec Kit): chạy lệnh gỡ của Spec Kit, rồi xoá đúng các file mà `specify init` đã tạo và chưa bị sửa. Danh sách file này được ghi vào manifest lúc cài.
- **Safety check:** cuối lệnh, mọi path đã đổi được đối chiếu với manifest. Có path ngoài manifest thì lệnh thoát mã 2.
- **Git hook của pilothify:** chỉ gỡ hook do `fe git-hooks install` cài trong clone này (theo bản ghi trong agent zone), hook do người khác cài thì giữ. Clone khác tự chạy `fe git-hooks uninstall`.

```text
/fe-delivery:fe-uninstall                          # xem trước rồi hướng dẫn từng bước
node "<plugin>/scripts/fe.mjs" uninstall --dry-run # chỉ đọc
node "<plugin>/scripts/fe.mjs" uninstall [--speckit] [--machine-state]
claude plugin uninstall fe-delivery@piloth-marketplace --scope project
```

Chạy bước apply bằng tiền tố `!` hoặc trong terminal, vì sandbox chặn ghi vào `.claude/`.

## Phát triển

```bash
npm run check          # kiểm cú pháp
npm test               # unit + test đầu-cuối cho hook (không cần mạng; pilothify là test double trong tests/fixtures/bin)
npm run test:contract  # contract với pilothify / Spec Kit đã cài; tool chưa cài (hoặc pilothify < 0.1.6 cho P9–P12) thì skip
claude plugin validate .
```

Phát hành: tăng `version` trong `.claude-plugin/plugin.json` và `package.json`, ghi `CHANGELOG.md`, rồi chạy `claude plugin tag --push` để tạo tag `fe-delivery--vX.Y.Z`.

Workflow `.github/workflows/speckit-update.yml` (U1) kiểm Spec Kit mới mỗi tuần và mở PR. Workflow này không bao giờ tự merge.
