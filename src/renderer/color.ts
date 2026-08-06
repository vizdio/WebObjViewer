export function hexToRgb(color: string): [number, number, number] {
    const normalized = color.trim().replace("#", "");

    if (normalized.length === 3) {
        const red = Number.parseInt(normalized[0] + normalized[0], 16);
        const green = Number.parseInt(normalized[1] + normalized[1], 16);
        const blue = Number.parseInt(normalized[2] + normalized[2], 16);
        return [red, green, blue];
    }

    return [
        Number.parseInt(normalized.slice(0, 2), 16),
        Number.parseInt(normalized.slice(2, 4), 16),
        Number.parseInt(normalized.slice(4, 6), 16),
    ];
}
