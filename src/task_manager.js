const { goals } = require('mineflayer-pathfinder');
const { logger } = require('./utils');
const Vec3 = require('vec3');

class TaskManager {
    constructor(bot, skills) {
        this.bot = bot;
        this.skills = skills;
        this.currentTask = null; // { type: 'mine', target: 'oak_log', amount: 10, collected: 0 }
    }

    isBusy() {
        return this.currentTask !== null;
    }

    startTask(task) {
        logger.info(`Starting long task: ${task.type}`, task);
        this.currentTask = task;
    }

    stopTask() {
        if (this.currentTask) {
            logger.info(`Stopping task: ${this.currentTask.type}`);
            this.bot.pathfinder.setGoal(null);
            this.currentTask = null;
        }
    }

    async update() {
        if (!this.currentTask) return false;

        const task = this.currentTask;

        try {
            if (task.type === 'mine') {
                await this.handleMiningTask(task);
            } else if (task.type === 'gather_wood') {
                await this.handleGatherWoodTask(task);
            } else if (task.type === 'farm') {
                await this.handleFarmTask(task);
            } else if (task.type === 'defend') {
                // Combat logic handled by PVP plugin mostly, but we can monitor safety
                if (!this.bot.nearestEntity(e => e.type === 'mob' && e.position.distanceTo(this.bot.entity.position) < 10)) {
                    this.stopTask(); // No enemies nearby
                }
            }
        } catch (e) {
            logger.error(`Task error: ${task.type}`, e);
            this.stopTask();
            return false; // Task failed
        }
        
        return true; // Still working
    }

    async handleMiningTask(task) {
        // Check if we have enough
        const targetName = this.skills.normalizeItemName(task.target);
        const targetItem = this.bot.registry.itemsByName[targetName];
        if (!targetItem) {
            this.bot.chat(`что за ${targetName}? не понимаю`);
            this.stopTask();
            return;
        }
        const count = this.bot.inventory.count(targetItem.id);
        if (count >= task.amount) {
            this.bot.chat(`собрал ${targetName}, хватит пока`);
            this.stopTask();
            return;
        }

        // Check if we are already mining or moving
        if (this.bot.pathfinder.isMoving()) return;
        if (this.bot.targetDigBlock) return; // Already digging

        // Find closest block
        const positions = this.bot.findBlocks({
            matching: b => b.name === targetName,
            maxDistance: 32,
            count: 20
        });
        const block = positions
            .map(pos => this.bot.blockAt(pos))
            .find(candidate => candidate && this.skills.isSafeToMine(candidate));

        if (!block) {
            this.bot.chat(`больше не вижу ${targetName} рядом`);
            this.stopTask();
            return;
        }

        // Go and mine
        try {
            await this.bot.collectBlock.collect(block);
            // We don't stop task here, we wait for next update loop to check count
        } catch (e) {
            // If pathfinding fails repeatedly, abort
            logger.warn(`Mining step failed: ${e.message}`);
            // Wander a bit?
            this.stopTask();
        }
    }

    async handleGatherWoodTask(task) {
        const defaultTypes = [
            'oak_log', 'birch_log', 'spruce_log', 'jungle_log',
            'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'
        ];
        const types = Array.isArray(task.types) && task.types.length > 0
            ? task.types.map(name => this.skills.normalizeItemName(name))
            : defaultTypes;

        let total = 0;
        for (const type of types) {
            const item = this.bot.registry.itemsByName[type];
            if (!item) continue;
            total += this.bot.inventory.count(item.id);
        }
        if (total >= task.amount) {
            this.bot.chat(`дрова собраны (${total})`);
            this.stopTask();
            return;
        }

        if (this.bot.pathfinder.isMoving()) return;
        if (this.bot.targetDigBlock) return;

        const positions = this.bot.findBlocks({
            matching: b => types.includes(b.name),
            maxDistance: 48,
            count: 30
        });

        const block = positions
            .map(pos => this.bot.blockAt(pos))
            .find(candidate => candidate && this.skills.isSafeToMine(candidate));

        if (!block) {
            const now = Date.now();
            if (!task.lastWanderAt || now - task.lastWanderAt > 12000) {
                task.lastWanderAt = now;
                await this.skills.wander({ range: 32 });
            }
            return;
        }

        try {
            await this.bot.collectBlock.collect(block);
        } catch (e) {
            logger.warn(`Wood gather failed: ${e.message}`);
            this.stopTask();
        }
    }

    async handleFarmTask(task) {
        const cropTypes = task.crops && task.crops.length
            ? task.crops.map(name => this.skills.normalizeItemName(name))
            : ['wheat', 'potatoes', 'carrots', 'beetroots'];

        const maxAge = {
            wheat: 7,
            potatoes: 7,
            carrots: 7,
            beetroots: 3
        };
        const seedByCrop = {
            wheat: 'wheat_seeds',
            potatoes: 'potato',
            carrots: 'carrot',
            beetroots: 'beetroot_seeds'
        };

        if (this.bot.pathfinder.isMoving()) return;
        if (this.bot.targetDigBlock) return;

        const positions = this.bot.findBlocks({
            matching: (block) => cropTypes.includes(block.name),
            maxDistance: 32,
            count: 30
        });

        const matureBlock = positions
            .map(pos => this.bot.blockAt(pos))
            .find(block => {
                if (!block) return false;
                const props = typeof block.getProperties === 'function' ? block.getProperties() : block.properties;
                const age = props && Number.isFinite(Number(props.age)) ? Number(props.age) : 0;
                const needed = maxAge[block.name] ?? 7;
                return age >= needed;
            });

        if (!matureBlock) {
            const now = Date.now();
            if (!task.lastWanderAt || now - task.lastWanderAt > 15000) {
                task.lastWanderAt = now;
                await this.skills.wander({ range: 24 });
            }
            return;
        }

        try {
            await this.bot.pathfinder.goto(new goals.GoalNear(matureBlock.position.x, matureBlock.position.y, matureBlock.position.z, 1));
            await this.bot.dig(matureBlock);
            await new Promise(r => setTimeout(r, 200));

            const seedName = seedByCrop[matureBlock.name];
            const seedItem = seedName ? this.bot.inventory.items().find(i => i.name === seedName) : null;
            const soil = this.bot.blockAt(matureBlock.position.offset(0, -1, 0));
            if (seedItem && soil && soil.name === 'farmland') {
                await this.bot.equip(seedItem, 'hand');
                await this.bot.placeBlock(soil, new Vec3(0, 1, 0));
            }
        } catch (e) {
            logger.warn(`Farm step failed: ${e.message}`);
        }
    }
}

module.exports = TaskManager;
