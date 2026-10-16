export const CADENCE = 300;
export const PHASE = 120;
export const HORIZON = 365 * 86400;
export const firstSlot = start => PHASE + CADENCE * Math.ceil((start - PHASE) / CADENCE);
export const slotCount = (start, end) => Math.max(0, Math.ceil((end - firstSlot(start)) / CADENCE));
export const isDiscovery = at => {
  const d = new Date(at * 1000);
  return d.getUTCMinutes() === 2 && d.getUTCHours() % 4 === 0;
};
