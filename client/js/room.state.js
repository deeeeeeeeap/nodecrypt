// Shared room state (single source of truth for roomsData / activeRoomIndex)
// 共享房间状态（roomsData / activeRoomIndex 的唯一数据源）
export const roomsData = [];
export let activeRoomIndex = -1;

// ESM exports are read-only bindings for importers, so reassignment goes through this setter.
// ESM 导出对引用方是只读绑定，重新赋值必须经过此 setter。
export function setActiveRoomIndex(index) {
	activeRoomIndex = index
}
