# Changelog

## Chưa phát hành

- **Contract Spec Kit:** mở rộng thành K0–K9 và K11:
  - phiên bản nằm trong range;
  - frontmatter `name` của skill khớp tên thư mục (đây là giá trị tool `Skill` nhận);
  - `feature.json` lưu đường dẫn tương đối và không đổi branch;
  - template tasks dùng checkbox;
  - implement dừng khi checklist chưa tick; converge chỉ append; clarify hỏi từng câu;
  - `integration upgrade` không ghi đè file đã sửa tay;
  - git extension không tự cài.
- **`fe-setup`:** không cài git extension của Spec Kit; khi merge settings thì giữ các hook event mà Spec Kit đã ghi.
- **Đã kiểm với Spec Kit 1.4.0 thật:** 7/7 contract pass.
- **Kiểm thật trong Claude Code 2.1.322:** gọi `speckit-plan` khi chưa có `spec.md` bị G1 chặn. Lần chạy này xác nhận tool `Skill` truyền tên skill qua trường `skill`.
- **Workflow `speckit-update`:** kiểm E1 qua `workflow_dispatch` với bản đã kiểm → không mở PR.

## v0.1.0 — 2026-11-16 (chưa phát hành)

Bản đầu tiên, dựng theo blueprint v2.

- **Skill:** conductor `fe-deliver` với 5 tier (trivial, small, medium, large, bug); `fe-setup`, `speckit-upgrade`.
- **Agent:** `fe-intake` (chỉ đọc), `fe-verifier`, `fe-reviewer`.
- **Hook:** guard U1, S, G0–G6, SA, P1–P3, T1. PreToolUse fail-closed (`onFailure: block` cùng deny khi guard gặp lỗi).
- **CLI `fe`:** quản lý vòng đời run, lưu intake theo schema, classify kèm floor (glob + blast radius từ graph pilothify, chỉ tính cạnh EXTRACTED), câu hỏi gate, `verify` (evidence có trailer), claim L2/L3, report tất định.
- **Contract test:** pilothify P1–P8 chạy với 0.1.5; Spec Kit K1–K2, tự skip khi chưa cài `specify`.
- **CI:** test unit trên Node 18/20/22; workflow `speckit-update` chạy hằng tuần.
