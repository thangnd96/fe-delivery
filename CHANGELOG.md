# Changelog

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
