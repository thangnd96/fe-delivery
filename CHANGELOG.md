# Changelog

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
