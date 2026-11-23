# Changelog

## v0.4.0 — 2026-11-23

Graph phải được query trước khi đọc code, và phải luôn khớp code. Bản này cần pilothify 0.1.6 (`update --full`, `hook install --no-merge-driver`, sửa lỗi bản tăng dần để lại stub khi import qua barrel). Chạy với 0.1.5 vẫn được, nhưng đầu phiên sẽ nhắc nâng cấp.

- **Query graph trước (A):**
  - `fe intake save` kiểm bước graph: `codebase.queries` không được rỗng; query nào ra exit 4 phải ghi `fallback` grep (trường mới, gồm `tool` và `pattern`); hook phải thấy query đó đã thật sự chạy trong run; và run phải có ít nhất một lần refresh graph thành công. Mỗi query trong intake nay bắt buộc có `question` và `exit_code`.
  - Luật mới G9: trong run, `fe-intake` chưa được dùng `grep`/`rg`/`find`/`git grep`, Grep hay Glob khi run chưa có `pilothify query`/`explain` nào. Matcher của PreToolUse nay gồm cả `Grep|Glob|Agent|Task`. Mọi lần chạy `pilothify query|explain|path|affected` (cả qua MCP) đều được hook ghi lại.
  - Luật mới G10: `fe-reviewer` chỉ bắt đầu khi graph khớp cây làm việc.
  - Report có mục `## Graph`: số lần refresh (full / tăng dần / không đổi / lỗi); số query của intake theo exit 0/3/4; có grep fallback không; số query hook thấy; graph so với cây làm việc; và các cảnh báo.
  - `graph.enforce` trong profile nhận `off`, `warn` hoặc `block`, mặc định `warn` (như `rollout.mode`). Mức `warn` cho đi tiếp, cảnh báo ở console và ghi vào report. Mức `block` thì từ chối `intake save`, chặn `fe classify` khi chưa có intake, và từ chối G9, G10. Mức `off` không refresh và không kiểm.
- **Graph theo code (B):**
  - Dấu độ mới là `{ head, fingerprint }`, gồm cả HEAD lẫn cây làm việc: hash của `git status`, `git diff HEAD` và nội dung file chưa track, bỏ qua `pilothify-out/`. `fe graph ensure` ghi `{ head, fingerprint, mode, at, exit, nodes }` vào dấu của checkout và vào run. Graph thiếu `built_at_commit` (`null`) hoặc chưa có dấu bị coi là lệch; trước đây đầu phiên bỏ qua graph `null`.
  - Vòng đời: `fe run start` dựng lại toàn bộ (`pilothify update --full`). `fe intake save`, `fe classify` (kể cả C3), `fe verify` (nên trước fe-reviewer graph đã có code mới) và `fe run end` gọi `update` khi dấu lệch. Sửa code thì không update.
  - Chờ khoá: trước khi đọc graph, fe chờ `pilothify-out/.rebuild.lock` được nhả (tối đa 100 s, có thông báo). Khoá do process đã chết để lại thì không chờ.
  - P4 (PostToolUse): lệnh git đổi cây làm việc (`checkout|switch|pull|merge|rebase|reset|stash|restore|cherry-pick|revert`) khởi chạy `pilothify update` ở nền (`scripts/graph-refresh.mjs`), và báo cho agent biết.
  - `fe git-hooks install|uninstall|status`: cài git hook của pilothify cho từng clone bằng `pilothify hook install --no-merge-driver`. Hook nối vào hook có sẵn (Husky, `core.hooksPath`), không ghi đè. fe ghi lại việc mình cài, nên chỉ gỡ hook do chính nó cài; `fe uninstall` gỡ luôn. `fe-setup` cài hook trừ khi profile đặt `graph.git_hooks: false`. Đầu phiên và `fe doctor` báo trạng thái hook. `.claude/settings.json` mẫu đặt `env.PILOTHIFY_REBUILD_LOG = pilothify-out/rebuild.log`.
  - Linked worktree: hook của pilothify bỏ qua ở đây, nên các điểm kiểm của fe tự update. Đầu phiên có nhắc.
  - Từ chối ghi là lỗi: pilothify từ chối ghi (guard chống co graph) hoặc thoát mã khác 0 thì `fe graph ensure` thoát mã 1, ghi rõ lý do, và không cập nhật dấu. Trước đây lệnh in "exit N" rồi vẫn coi là xong.
  - `fe graph status [--json]` mới: graph có khớp không, ai đang giữ khoá, trạng thái hook. `fe run status` có thêm trường `graph`.
- **Độ chính xác (C):** `fe graph ensure --full` dựng lại toàn bộ bằng pipeline của `update`, không dùng `extract` (pilothify 0.1.5 không có `--full` nên fe dùng `--force`). Lần dựng đầu tiên của repo vẫn là `extract --code-only`, để docs không thêm cạnh vào blast radius. Bản classification ghi thêm `graph` (`refresh`, `fresh`, `head`).
- **Đo trên bản clone của repo portal** (3.477 file code), pilothify 0.1.6:
  - đổi nhánh giữa phiên rồi `fe run start`: fe chờ lượt rebuild nền của hook, rồi graph khớp HEAD mới trước intake;
  - sau `fe run start`, node và cạnh trùng với bản dựng toàn bộ;
  - component thêm trong task hiện trong `pilothify affected` sau `fe verify`;
  - commit trong lúc hook đang dựng lại: `fe classify` chờ khoá rồi mới đọc graph;
  - trong linked worktree, hook bỏ qua nhưng graph vẫn được update.
- **Test:** 68 test unit, thêm 25 (`graph-lifecycle.test.mjs`). Cả 25 đỏ trên 0.3.1 và xanh trên bản này. pilothify trong test unit là test double ở `tests/fixtures/bin`. Thêm contract P9–P12 với pilothify 0.1.6 thật; chúng skip khi pilothify cũ hơn.
- **Chưa làm:** tự chuyển sang `--full` khi graph còn stub `external` mang tên đường dẫn trong repo. Trên repo portal, ngay cả bản dựng toàn bộ cũng có 18 stub như vậy, và chúng hợp lệ: import file JSON/CSS, hay re-export symbol của thư viện ngoài. Vì vậy dấu hiệu này không phân biệt được sai lệch. pilothify 0.1.6 đã hết sai lệch ở bản tăng dần, và mỗi run vẫn dựng lại toàn bộ lúc bắt đầu.
- **Nâng cấp repo đang dùng 0.3.x:**
  - không cần cài lại, vì mặc định là `warn`;
  - mỗi clone chạy `fe git-hooks install` một lần, ngoài sandbox;
  - muốn log của hook rebuild nằm trong repo thì thêm `"env": {"PILOTHIFY_REBUILD_LOG": "pilothify-out/rebuild.log"}` vào `.claude/settings.json`; `fe doctor` có nhắc;
  - nâng pilothify lên 0.1.6 theo `compat/speckit.json`.

## v0.3.1 — 2026-11-17

- **Làm thẳng trên checkout hiện tại, không ép tách worktree:**
  - `fe-deliver` (bước 1) và `speckit-upgrade` làm ngay trên checkout đang mở, trên nhánh đặt theo `jira.branch_template` (`git switch -c` khi đang ở nhánh mặc định hay nhánh tích hợp), nên dev thấy file thay đổi ngay trong editor của mình;
  - chỉ tạo worktree khi người dùng (hoặc chỉ dẫn của project) yêu cầu; nếu IDE hay app của họ quản lý worktree (Orca, Paseo, …) thì tạo qua app đó; phiên đã chạy sẵn trong một worktree thì ở lại đó, không lồng thêm;
  - đang ở nhánh của việc khác, hoặc có thay đổi chưa commit không thuộc việc này, thì hỏi trước; không tự stash, reset, bỏ hay commit thay đổi của dev;
  - khối `CLAUDE.md` mẫu và ngữ cảnh đầu phiên đổi theo; thông báo của CLI, hook và report nói "checkout" thay cho "worktree" (trường `worktree` trong state và trailer `FE_RUN_STARTED` giữ nguyên tên để tương thích).
- **Repo đã cài bản 0.3.0 trở về trước:** đầu phiên và `fe doctor` nhắc khi `CLAUDE.md` còn dòng "Delivery runs work in a git worktree…", vì dòng đó không còn áp dụng. Plugin không tự sửa `CLAUDE.md`; `fe uninstall` vẫn gỡ được khối đã sửa tay (theo marker).
- **Test:** 43 test unit (thêm 3, `workspace.test.mjs`) và 8 test contract đều pass.

## v0.3.0 — 2026-11-16

Phần lớn thay đổi đến từ lần cài thử trên bản clone của ba repo front-end thật.

- **Chế độ shadow được cưỡng chế (G7):**
  - run shadow khi profile đặt `rollout.mode = "shadow"`, khi người dùng viết `[stop-after:plan]`, hoặc khi chạy `fe run start --stop-after plan`;
  - hook chặn sửa mã nguồn sản phẩm và chặn `speckit-implement`, `speckit-converge`, `speckit-bug-fix`, `speckit-bug-test`;
  - nếu mã nguồn bị đổi qua đường khác thì run không kết thúc được cho tới khi hoàn tác;
  - report ghi trạng thái `PLANNED`.
- **Cấu hình guard cố định theo run (G8):**
  - mỗi run dùng bản profile chụp lúc bắt đầu;
  - khi đang giao việc, không được sửa profile và manifest bằng Edit/Write hay Bash;
  - xoá profile giữa run cũng không tắt được guard;
  - evidence có lệnh khác với profile đã chụp bị từ chối.
- **Sửa lỗi bằng chứng:** check fail trước đây vẫn được tính là bằng chứng, nên run có typecheck đỏ vẫn có thể ra report READY FOR REVIEW. Nay lần chạy mới nhất của mỗi check sau lần sửa cuối phải pass. Tương tự, kiểm tra UI L2 có kết quả `fail` thì run không kết thúc được.
- **Gỡ `--speckit` sạch:**
  - `fe install --speckit-installed-by-setup` ghi lại danh sách file Spec Kit đã tạo;
  - `fe uninstall --speckit` xoá đúng các file đó nếu chưa bị sửa, và giữ file team đã sửa (ví dụ constitution);
  - lệnh gỡ extension nay có `--force`, vì Spec Kit hỏi xác nhận và tự huỷ khi không có TTY.
- **Chỉ nhắc, không can thiệp sâu:**
  - `fe install` và `fe doctor` in một dòng nhắc khi profile, manifest hoặc `.claude/settings.json` bị repo gitignore; plugin không sửa `.gitignore` của consumer ngoài khối của chính nó;
  - đầu phiên và `fe doctor` nhắc khi `.mcp.json` còn dùng endpoint Atlassian v1 đã bị deprecate; plugin không đổi cấu hình MCP.
- **Không cố định Jira site:** profile mẫu bỏ `jira.site`; chỉ cần project key để nhận ra ticket trong prompt, và danh sách được để trống.
- **`rollout.mode` do consumer chọn:** mặc định `full`; `shadow` là lựa chọn khi muốn thử mà không sửa code.
- **`fe-setup`:** đề nghị chạy từng check trên checkout sạch và báo check nào đỏ (consumer tự quyết sửa, thu hẹp hay bỏ); hỏi `rollout.mode`; chỉ hỏi Jira project key; nhắc chứ không ép đổi kết nối Atlassian; ghi chú rằng baseline adherence đọc transcript trên chính máy của từng dev.
- **Test:** 40 test unit (thêm 12) và 8 test contract đều pass.

## v0.2.0 — 2026-11-16

- **Gỡ cài đặt sạch theo manifest:** `fe install` thay cho việc ghi file bằng tay trong `fe-setup`, và ghi từng thay đổi vào `.fe-delivery/install-manifest.json`:
  - file tạo mới;
  - entry thêm vào `.claude/settings.json`;
  - khối có đánh dấu trong `CLAUDE.md` và `.gitignore`;
  - thư mục tạo mới.
- **`fe install` không ghi đè giá trị có sẵn:** chỉ thêm key và rule còn thiếu, và báo xung đột.
- **`fe uninstall [--dry-run]`:**
  - khôi phục y nguyên từng byte những file chưa bị sửa sau khi cài;
  - với file đã bị sửa thì chỉ gỡ phần của fe-delivery;
  - không đụng `src/`, `specs/`, constitution, worktree, branch;
  - safety check bằng `git status` (thoát mã 2 nếu có path ngoài manifest bị đổi);
  - từ chối khi còn run đang mở hoặc có thay đổi chưa commit;
  - tuỳ chọn `--speckit` (chỉ khi `fe-setup` đã cài Spec Kit) và `--machine-state`.
- **Skill `/fe-delivery:fe-uninstall`:** xem trước, hướng dẫn apply, kiểm tra lại, rồi gỡ plugin.
- **`fe-setup`:** không cài git hook của pilothify, vì `fe graph ensure` đã giữ graph mới.
- **Test:** thêm 5 test cài và gỡ, gồm khôi phục byte-identical, giữ chỉnh sửa của team, `src/` không đổi, các trường hợp bị từ chối, và `pilothify-out/`. Tổng 28 test.

## v0.1.0 — 2026-11-16

Bản đầu tiên, dựng theo blueprint v2.

- **Skill:** conductor `fe-deliver` với 5 tier (trivial, small, medium, large, bug); `fe-setup`, `speckit-upgrade`.
  - `fe-setup` không cài git extension của Spec Kit, và khi merge settings thì giữ các hook event mà Spec Kit đã ghi.
- **Agent:** `fe-intake` (chỉ đọc), `fe-verifier`, `fe-reviewer`.
- **Hook:** guard U1, S, G0–G6, SA, P1–P3, T1. PreToolUse fail-closed (`onFailure: block` cùng deny khi guard gặp lỗi).
- **CLI `fe`:**
  - quản lý vòng đời run;
  - lưu intake theo schema;
  - classify kèm floor (glob + blast radius từ graph pilothify, chỉ tính cạnh EXTRACTED);
  - câu hỏi gate;
  - `verify` (evidence có trailer);
  - claim L2/L3;
  - report tất định.
- **Test:**
  - 23 test unit và đầu-cuối cho hook;
  - contract pilothify P1–P8, chạy với 0.1.5;
  - contract Spec Kit K0–K9 và K11, 7/7 pass với 1.4.0.
- **Kiểm thật trong Claude Code 2.1.322:**
  - Edit khi chưa có run bị G0 chặn;
  - run được đăng ký và evidence được ghi từ output Bash thật;
  - gọi `speckit-plan` khi chưa có `spec.md` bị G1 chặn.
- **CI:** test unit trên Node 18/20/22; workflow `speckit-update` chạy hằng tuần và đã kiểm E1.
