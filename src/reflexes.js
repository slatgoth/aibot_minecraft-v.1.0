const { goals } = require('mineflayer-pathfinder');
const { logger } = require('./utils');

class Reflexes {
    constructor(bot, planner) {
        this.bot = bot;
        this.planner = planner;
        this.lastEatTime = 0;
        this._onTick = null;
        this._onHealth = null;
    }

    start() {
        if (!this._onTick) {
            this._onTick = () => this.checkThreats();
            this.bot.on('physicsTick', this._onTick);
        }
        if (!this._onHealth) {
            this._onHealth = () => this.checkHealth();
            this.bot.on('health', this._onHealth);
        }
    }

    stop() {
        if (this._onTick) {
            this.bot.removeListener('physicsTick', this._onTick);
            this._onTick = null;
        }
        if (this._onHealth) {
            this.bot.removeListener('health', this._onHealth);
            this._onHealth = null;
        }
    }

    async checkHealth() {
        if (this.bot.health < 10 && this.bot.food < 20) {
            if (Date.now() - this.lastEatTime > 5000) {
                // Auto eat if low health
                const food = this.bot.inventory.items().find(i => i.food > 0);
                if (food) {
                    logger.info('Reflex: Low HP, eating!');
                    try {
                        await this.bot.equip(food, 'hand');
                        await this.bot.consume();
                        this.lastEatTime = Date.now();
                    } catch(e) {}
                }
            }
        }
    }

    async checkThreats() {
        // Creeper reflex
        const creeper = this.bot.nearestEntity(e => e.name === 'creeper' && e.position.distanceTo(this.bot.entity.position) < 4);
        if (creeper) {
            // Panic mode
            logger.warn('Reflex: CREEPER!');
            
            // 1. Stop whatever we are doing
            this.planner.taskManager.stopTask();
            this.bot.pathfinder.setGoal(null);

            // 2. Run away
            const escapeVec = this.bot.entity.position.minus(creeper.position).normalize().scaled(5).plus(this.bot.entity.position);
            this.bot.lookAt(creeper.position);
            this.bot.setControlState('back', true);
            this.bot.setControlState('sprint', true);
            
            // Shield?
            const shield = this.bot.inventory.items().find(i => i.name === 'shield');
            if (shield) {
                this.bot.equip(shield, 'off-hand');
                this.bot.activateItem(true); // Right click
            }

            setTimeout(() => {
                this.bot.setControlState('back', false);
                this.bot.setControlState('sprint', false);
                this.bot.deactivateItem();
            }, 1000);
        }
    }
}

module.exports = Reflexes;
