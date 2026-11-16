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
| `hooks/hooks.json` → `scripts/hook.mjs` | Guard: U1 · S · G0–G6 · SA · P1–P3 · T1. |
| `scripts/fe.mjs` | CLI cho conductor: `run`, `intake`, `classify`, `gate`, `verify`, `evidence`, `report`, `graph`, `doctor`, `install`, `uninstall`. |
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
| SA | PreToolUse | `fe-intake`/`fe-reviewer` chỉ đọc; `fe-verifier` không sửa file; subagent không được gọi MCP ghi. |
| P1 | PostToolUse | Ghi approval từ câu trả lời của người. Chỉ đúng chữ "Approve" mới được tính. |
| P2 | PostToolUse | Tính lại diff từ git; `last_edit_at` chỉ đổi khi nội dung file đổi. |
| P3 | PostToolUse | Chỉ tin trailer `FE_*` khi lệnh là một lệnh `fe` trần (không nối lệnh): bắt đầu run, ghi evidence, kết thúc run. |
| T1 | Stop | Run có thay đổi mà thiếu điều kiện → chặn một lần cho mỗi lượt sửa. |

## State nằm ngoài repo

- **Agent zone** `~/.fe-delivery/agent/`: CLI `fe` ghi vào đây. Settings cho phép sandbox ghi vào thư mục này.
- **Hook zone** `~/.fe-delivery/hook/`: chỉ hook ghi, gồm active run, approval, evidence đo được, diff, events. Bash bị chặn truy cập ở hai lớp: rule G5 và sandbox.

Khi tắt sandbox, việc bảo vệ hook zone chỉ còn ở mức best-effort; `fe doctor` sẽ cảnh báo.

## Cài đặt

Plugin được phát hành qua `piloth-marketplace`:

```text
/plugin marketplace add thangnd96/piloth
/plugin install fe-delivery@piloth-marketplace
```

Sau đó mở repo FE và chạy `/fe-delivery:fe-setup`. pilothify chỉ cài từ GitHub và phải pin tag (xem `compat/speckit.json`).

## Gỡ cài đặt

`fe install`, do `fe-setup` gọi, ghi mọi thay đổi trong repo vào `.fe-delivery/install-manifest.json`. `fe uninstall` chỉ đảo ngược đúng những gì có trong manifest:

- **File chưa bị sửa sau khi cài:** khôi phục y nguyên từng byte.
- **File đã bị sửa:** chỉ gỡ entry hoặc khối do fe-delivery thêm, phần của team giữ nguyên.
- **Không bao giờ đụng tới:** `src/`, `specs/`, constitution của Spec Kit, worktree, branch, lịch sử commit.
- **Safety check:** cuối lệnh, mọi path đã đổi được đối chiếu với manifest. Có path ngoài manifest thì lệnh thoát mã 2.

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
npm test               # unit + test đầu-cuối cho hook (không cần mạng)
npm run test:contract  # contract với pilothify / Spec Kit đã cài; tool chưa cài thì skip
claude plugin validate .
```

Phát hành: tăng `version` trong `.claude-plugin/plugin.json` và `package.json`, ghi `CHANGELOG.md`, rồi chạy `claude plugin tag --push` để tạo tag `fe-delivery--vX.Y.Z`.

Workflow `.github/workflows/speckit-update.yml` (U1) kiểm Spec Kit mới mỗi tuần và mở PR. Workflow này không bao giờ tự merge.
