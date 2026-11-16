# Changelog

## v0.1.0 — 2026-11-16 (chưa phát hành)

Bản đầu tiên, dựng theo blueprint v2.

- **Skill:** conductor `fe-deliver` với 5 tier (trivial, small, medium, large, bug); `fe-setup`, `speckit-upgrade`.
- **Agent:** `fe-intake` (chỉ đọc), `fe-verifier`, `fe-reviewer`.
- **Hook:** guard U1, S, G0–G6, SA, P1–P3, T1. PreToolUse fail-closed (`onFailure: block` cùng deny khi guard gặp lỗi).
- **CLI `fe`:** quản lý vòng đời run, lưu intake theo schema, classify kèm floor (glob + blast radius từ graph pilothify, chỉ tính cạnh EXTRACTED), câu hỏi gate, `verify` (evidence có trailer), claim L2/L3, report tất định.
- **Contract test:** pilothify P1–P8 chạy với 0.1.5; Spec Kit K1–K2, tự skip khi chưa cài `specify`.
- **CI:** test unit trên Node 18/20/22; workflow `speckit-update` chạy hằng tuần.
