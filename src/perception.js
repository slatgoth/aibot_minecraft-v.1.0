const memory = require('./memory_store');
const config = require('./config');

class Perception {
    constructor(bot) {
        this.bot = bot;
        this.itemParser = require('prismarine-item')(bot.version);
    }

    isStructureBlockName(name) {
        if (!name) return false;
        const patterns = [
            'planks', 'brick', 'bricks', 'stairs', 'slab', 'wall', 'fence', 'gate',
            'door', 'trapdoor', 'glass', 'pane', 'torch', 'lantern', 'bed', 'carpet',
            'banner', 'sign', 'chest', 'barrel', 'furnace', 'crafting_table', 'anvil',
            'smithing', 'enchanting', 'loom', 'cartography', 'stonecutter',
            'grindstone', 'lectern', 'jukebox', 'composter', 'beehive', 'beacon',
            'concrete', 'terracotta', 'wool', 'glazed', 'prismarine', 'quartz',
            'deepslate_bricks', 'polished', 'smooth', 'tiles'
        ];
        return patterns.some(p => name.includes(p));
    }

    readSignText(block) {
        if (!block) return '';
        const raw = block.signText || block._signText || block.text || null;
        if (!raw && block.nbt && block.nbt.value && block.nbt.value.Text1) {
            try {
                const lines = ['Text1', 'Text2', 'Text3', 'Text4']
                    .map(key => block.nbt.value[key]?.value || '')
                    .filter(Boolean);
                return lines.join(' ').trim();
            } catch (e) {
                return '';
            }
        }
        if (Array.isArray(raw)) return raw.filter(Boolean).join(' ').trim();
        if (raw && typeof raw.getText === 'function') {
            const lines = raw.getText();
            if (Array.isArray(lines)) return lines.filter(Boolean).join(' ').trim();
        }
        if (raw && raw.lines && Array.isArray(raw.lines)) {
            return raw.lines.filter(Boolean).join(' ').trim();
        }
        if (typeof raw === 'string') return raw.trim();
        return '';
    }

    getItemEntityInfo(entity, origin) {
        const meta = Array.isArray(entity.metadata) ? entity.metadata : [];
        let stack = null;
        for (const entry of meta) {
            if (!entry || typeof entry !== 'object') continue;
            if (Object.prototype.hasOwnProperty.call(entry, 'itemId')) {
                stack = entry;
                break;
            }
            if (entry.present && entry.itemId !== undefined) {
                stack = entry;
                break;
            }
        }
        if (!stack || stack.itemId === undefined) return null;
        const item = this.itemParser.fromNotch({
            type: stack.itemId,
            count: stack.itemCount || 1,
            nbt: stack.nbt || stack.itemNbt || null
        });
        const distance = origin ? origin.distanceTo(entity.position) : 0;
        return {
            name: item && item.name ? item.name : `item_${stack.itemId}`,
            count: item && item.count ? item.count : (stack.itemCount || 1),
            position: {
                x: Math.floor(entity.position.x),
                y: Math.floor(entity.position.y),
                z: Math.floor(entity.position.z)
            },
            distance: Number(distance.toFixed(1))
        };
    }

    scan() {
        const bot = this.bot;
        const pos = bot.entity.position;
        const behavior = config.behavior || {};
        const entityRadius = Number.isFinite(Number(behavior.scanRadiusEntities)) ? Number(behavior.scanRadiusEntities) : 36;
        const blockRadius = Number.isFinite(Number(behavior.scanRadiusBlocks)) ? Number(behavior.scanRadiusBlocks) : 12;
        const dropRadius = Number.isFinite(Number(behavior.scanRadiusDrops)) ? Number(behavior.scanRadiusDrops) : 18;
        
        const entities = Object.values(bot.entities)
            .filter(e => e.id !== bot.entity.id && e.position.distanceTo(pos) < entityRadius)
            .map(e => ({
                id: e.id,
                name: e.name || e.username || 'unknown',
                type: e.type,
                distance: e.position.distanceTo(pos).toFixed(1),
                position: e.position
            }));

        const drops = Object.values(bot.entities)
            .filter(e => e.type === 'object' && e.name === 'item' && e.position.distanceTo(pos) < dropRadius)
            .map(e => this.getItemEntityInfo(e, pos))
            .filter(Boolean);

        const blocks = bot.findBlocks({
            matching: (block) => block.type !== 0, // Not air
            maxDistance: blockRadius,
            count: 30
        }).map(p => bot.blockAt(p)).filter(Boolean);

        const structureBlocks = new Set();
        const naturalBlocks = new Set();
        const signs = [];
        for (const block of blocks) {
            if (block.name && block.name.includes('sign')) {
                const text = this.readSignText(block);
                signs.push({
                    name: block.name,
                    text,
                    position: {
                        x: Math.floor(block.position.x),
                        y: Math.floor(block.position.y),
                        z: Math.floor(block.position.z)
                    }
                });
            }
            if (this.isStructureBlockName(block.name)) {
                structureBlocks.add(block.name);
            } else {
                naturalBlocks.add(block.name);
            }
        }

        const players = Object.values(bot.players).map(p => {
            const name = p.username;
            let position = null;
            let distance = null;
            let hasEntity = false;
            let lastSeen = null;
            let lastPosition = null;

            if (p.entity && p.entity.position) {
                hasEntity = true;
                position = {
                    x: Math.floor(p.entity.position.x),
                    y: Math.floor(p.entity.position.y),
                    z: Math.floor(p.entity.position.z)
                };
                distance = Number(p.entity.position.distanceTo(pos).toFixed(1));
                memory.setLastSeen(name, position);
                lastSeen = Date.now();
                lastPosition = position;
            } else {
                const mem = memory.getPlayer(name);
                lastSeen = mem.lastSeen || null;
                lastPosition = mem.lastPosition || null;
            }

            return {
                name,
                position,
                distance,
                hasEntity,
                muted: memory.isMuted(name),
                lastSeen,
                lastPosition
            };
        });

        const blockNames = blocks.map(b => b.name);
        const uniqueBlocks = [...new Set(blockNames)];

        return {
            time: bot.time.timeOfDay,
            isDay: bot.time.isDay,
            biome: bot.blockAt(pos)?.biome?.name || 'unknown',
            nearbyEntities: entities,
            nearbyBlocks: uniqueBlocks,
            nearbyStructures: Array.from(structureBlocks),
            nearbyNatural: Array.from(naturalBlocks),
            nearbySigns: signs,
            nearbyDrops: drops,
            playerPlacedBlocks: memory.getPlacedBlocksNear(pos, 16, 20),
            players,
            playersOnline: players.map(p => p.name),
            health: bot.health,
            food: bot.food,
            inventory: bot.inventory.items().map(i => `${i.name} x${i.count}`),
            position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
        };
    }
}

module.exports = Perception;
