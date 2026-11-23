# Changelog

## v0.4.3 — 2026-11-23

Dấu độ mới của graph nay giống nhau dù tính trong hay ngoài sandbox của Claude Code.

- **Fingerprint khớp trong và ngoài sandbox.**
  - Sandbox chặn đọc `.env`, `.env.*`, `*.pem` và `*.key`. Vì vậy trong sandbox, `git diff HEAD` báo các file này là đã xoá (`D .env.dev`), còn `git status` bỏ qua chúng. Ngoài sandbox, git thấy chúng bình thường.
  - Hậu quả là cùng một cây làm việc có hai fingerprint. Trên portal, `fe doctor` và `fe graph status` chạy trong sandbox báo graph lệch dù cây sạch và HEAD trùng với dấu.
  - Hai hậu quả khác suy ra từ code, chưa quan sát thật:
    - G10 có thể báo lệch sai. Ở mức `block`, fe-reviewer sẽ bị chặn.
    - Refresh nền và các điểm kiểm có thể refresh qua lại, làm report đếm sai số lần refresh.
- **Fingerprint nay bỏ qua hai loại path:**
  - `.env`, `.env.*`, `*.pem` và `*.key` ở mọi cấp thư mục (`SECRET_GLOBS`).
    - Một test kiểm rằng mọi luật `Read(...)` bị cấm trong `templates/settings.example.json` đều có trong `SECRET_GLOBS`.
    - Template vẫn cho đọc `.env.example`, nhưng file này cũng bị bỏ qua. Như vậy không sao, vì pilothify không đưa nó vào graph.
  - Path mà process không đọc được (EPERM/EACCES) do một luật cấm khác. Đó có thể là:
    - file đang track mà git báo nhầm là đã xoá;
    - file chưa track mà sandbox vẫn cho thấy tên;
    - thư mục không liệt kê được, nếu trong đó có file đang track. Thư mục được gộp thành một mục, nên các file chưa track ở trong cũng được bỏ qua.

    Dấu ghi lại các path này ở trường `unreadable`, và phía kiểm tra ở bên kia sandbox bỏ qua đúng các path đó. `fe graph status` liệt kê chúng ở trường `unreadable_paths`.
    - Dấu không thể mang mục `.` hay một path sai dạng.
    - Mục đúng dạng như `src` vẫn được chấp nhận. Dấu nằm trong vùng mà agent ghi được, nên bản thân dấu vốn đã có thể bị làm giả.
- **Giới hạn còn lại, chỉ khi team tự thêm luật cấm đọc.** Template không gặp các trường hợp này.
  - Lần refresh nền (`graph-refresh.mjs`, chạy ngoài sandbox) không thấy các path bị ẩn. Vì vậy, nếu dưới luật cấm có file chưa track hoặc file đã sửa, thì sau mỗi lần refresh nền, lần kiểm đầu tiên trong sandbox sẽ refresh thêm một lần. Report đếm cả những lần này.
  - G10 vẫn báo lệch như 0.4.2 trong hai trường hợp:
    - file chưa track nằm trong một thư mục mà sandbox không liệt kê được, khi trong thư mục đó không có file đang track nào bị ẩn;
    - file mới hoặc file `git mv` đã stage vào một path bị cấm theo từng file.
  - Có hơn 1.000 mục không đọc được (đếm sau khi gộp theo thư mục), hoặc khoảng 200 KB tham số. Khi đó fingerprint là `null` trong suốt thời gian còn từng ấy path bị ẩn:
    - graph luôn bị coi là lệch;
    - G10 ở mức `block` tiếp tục chặn;
    - `fe graph ensure` không gỡ được.

    Lý do đầy đủ chỉ hiện khi chạy `fe graph status` trong sandbox. Ngoài sandbox, G10 chỉ báo "working tree changed since the last refresh". Dù vậy, đây vẫn là trạng thái báo lệch, không bao giờ âm thầm báo "fresh".
  - Mục thư mục mà một dấu đã ghi vẫn tiếp tục bị bỏ qua sau khi luật cấm được gỡ. Tình trạng này kéo dài cho tới khi có lần refresh ghi dấu mới; `fe run start` luôn làm việc đó.
- **Không còn báo "fresh" nhầm khi lỗi.** Khi git lỗi, hoặc vượt giới hạn trên, fingerprint là `null`. Graph bị coi là lệch, kèm lý do, và `fe graph ensure` in cảnh báo. Ở 0.4.2, nếu git lỗi (ví dụ không đọc được `.git/index`), fingerprint lại ra giá trị của cây sạch.
- **Dấu cũ vẫn dùng được, với một ngoại lệ.** Khi các file trên không có thay đổi, fingerprint giống hệt bản 0.4.2, nên dấu ghi ngoài sandbox trước khi nâng cấp vẫn khớp. Riêng dấu mà 0.4.2 ghi trong sandbox, ở repo có track file `.env*`, sẽ bị coi là lệch một lần. Việc này tốn thêm một lần refresh.
- **Lỗi pilothify dễ đọc hơn.** Khi pilothify lỗi, `fe graph ensure` in dòng nêu lỗi và đường dẫn tới log đầy đủ (`<id>.last-failure.log`, nằm cạnh dấu). Trước đây lệnh in 6 dòng cuối của traceback, nối với nhau bằng `|`.
  - Ứng viên là dòng exception của traceback cuối cùng (đúng với exception sau cùng của một chuỗi, bất kể exception tên gì), và dòng `error:`/`fatal:`. Dòng nào in sau thì thắng. Nhờ vậy traceback debug in trước dòng `error:` cuối không được chọn.
  - Với ExceptionGroup, luôn lấy dòng của group ngoài cùng, kể cả khi sau đó còn dòng `error:`. pilothify hiện không dùng ExceptionGroup.
  - Nếu sau lỗi thật, Python còn in thêm một traceback "Exception ignored in …" lúc tắt (ví dụ một `ResourceWarning` của process pool), thì dòng cuối của traceback đó có thể được chọn. Lỗi thật vẫn có trong log đầy đủ.
  - Đường dẫn chứa chữ "error" không bị nhận nhầm. Traceback bị cắt cụt, không có dòng exception, thì được báo đúng như vậy.
  - Process bị kill thì thông báo ghi `killed by SIGKILL`.
  - pilothify được gọi với `NO_COLOR=1` và `PYTHON_COLORS=0`, nên log và thông báo không có mã màu.
- **Ghi chú về lần dựng graph đầu tiên** (thêm vào `fe-setup`). Số đo trong sandbox, trên portal (pilothify quét 3.440 file):
  - Lần dựng đầu mất 26 s với pilothify 0.1.7, so với 17 s ở bản 0.1.5.
  - Lần `update --full` đầu tiên sau đó mất 22 s, dù cache trúng 100%.
  - Từ lần thứ hai trở đi chỉ mất 11–13 s, kể cả khi đổi nhánh có đổi lockfile.
  - Lý do có thể là: từ pilothify 0.1.7, lần đầu ghi cache AST cho mọi file JS/TS (khoảng 33 MB). Trên máy có phần mềm diệt virus như Microsoft Defender, lần đầu đọc lại các file cache vừa ghi cũng chậm.
- **Test.** Có 81 test unit, thêm 12 test mới.
  - Hai cách ẩn file khỏi git:
    - `chmod 000` một thư mục: git gặp lỗi EACCES và không liệt kê được thư mục. Cách này chạy được trên CI Linux.
    - `sandbox-exec` với profile Seatbelt (chỉ trên macOS): lỗi EPERM, tên file vẫn thấy được. Đây chính là cơ chế sandbox của Claude Code dùng.
  - Các test kiểm `graph status`, đầu phiên và G10 ở mức `block`, theo cả hai chiều: ghi dấu trong sandbox rồi kiểm ngoài, và ngược lại.
  - Đo trên portal bằng Seatbelt: bản 0.4.2 cho `1c022ab5…` ngoài sandbox và `5d71565e…` trong sandbox, bản 0.4.3 cho `1c022ab5…` ở cả hai phía.
  - Một agent độc lập đã kiểm hai vòng, trên bản sao, với Seatbelt và trên cả hai repo thật. Các giới hạn nó tìm ra mà chưa sửa được nêu ở trên.

## v0.4.2 — 2026-11-23

Repo cài mới nhận Spec Kit 1.4.3. Repo đang dùng nâng thẳng từ 1.4.0 lên 1.4.3 bằng `/fe-delivery:speckit-upgrade`.

- **Spec Kit 1.4.3** (PR #2, từ workflow `speckit-update`): `speckit.tested` 1.4.3, range `>=1.4.3 <1.5.0`, cài `specify-cli==1.4.3`; template profile ghi `versions.speckit` 1.4.3. Bản 1.4.3 chủ yếu sửa lỗi. Phần chạm tới fe-delivery: `specify init` hay `integration upgrade` lỗi giữa chừng thì được rollback (#5402), skill sinh ra có `argument-hint` (#5449), và skill của extension được chép kèm resource khai báo (#5383).
- **Thông báo đầu phiên:** repo pin bản cũ hơn 1.4.3 được nhắc chạy `/fe-delivery:speckit-upgrade`; nếu CLI `specify` trên máy chưa lên 1.4.3 thì có thêm dòng báo nằm ngoài range. Đây chỉ là thông báo, không lệnh nào bị chặn.
- **Test:** contract 10/10 với Spec Kit 1.4.3 và pilothify 0.1.7; 69 test unit.

## v0.4.1 — 2026-11-23

Repo cài mới nhận pilothify 0.1.7 và Spec Kit 1.4.2.

- **pilothify 0.1.7:** `fe-setup` cài pilothify từ tag `v0.1.7` (`compat/speckit.json` → `pilothify.tested`, `pilothify.install`). Bản này dùng cache AST cho file JS/TS. Trên repo front-end 3.440 file, rebuild toàn bộ khi cache đã ấm giảm từ 15,5 s xuống 9 s nếu chạy tuần tự như trong sandbox của Claude Code; graph không đổi. Mức tối thiểu vẫn là 0.1.6, nên repo đang dùng 0.1.6 không bị nhắc nâng cấp.
- **Spec Kit 1.4.2** (PR #1, từ workflow `speckit-update`): `speckit.tested` 1.4.2, range `>=1.4.2 <1.5.0`, cài `specify-cli==1.4.2`. Repo đang pin 1.4.0 sẽ thấy hai thông báo ở đầu phiên: Spec Kit đã cài nằm ngoài range, và nên chạy `/fe-delivery:speckit-upgrade`. Đây chỉ là thông báo, không lệnh nào bị chặn.
- **Template profile pin đúng phiên bản mà `fe-setup` cài:** `templates/profile.example.json` vẫn ghi Spec Kit 1.4.0 và pilothify 0.1.6, nên repo vừa setup đã bị nhắc là cũ. Nay template ghi 1.4.2 và 0.1.7. Một test unit mới so template với `compat`, và workflow `speckit-update` nâng luôn `versions.speckit` của template.
- **Workflow `speckit-update` chạy contract với pilothify đang pin:** trước đây workflow cài cứng `v0.1.5`, nên P9–P12 bị skip. Nay cài theo `compat/speckit.json` → `pilothify.tested`.
- **Test:** 69 test unit (thêm 1, đỏ trên 0.4.0); contract 10/10 với Spec Kit 1.4.2 và pilothify 0.1.7.

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
