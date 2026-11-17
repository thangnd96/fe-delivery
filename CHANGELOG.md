# Changelog

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
