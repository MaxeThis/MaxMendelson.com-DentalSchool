export const TWEEN = {
    tweens: [],

    add(tween) {
        this.tweens.push(tween);
        return tween;
    },

    remove(tween) {
        const index = this.tweens.indexOf(tween);
        if (index !== -1) this.tweens.splice(index, 1);
    },

    update(time) {
        for (let index = 0; index < this.tweens.length; index += 1) {
            if (this.tweens[index].update(time) === false) {
                this.tweens.splice(index, 1);
                index -= 1;
            }
        }
    }
};

export class Tween {
    constructor(target) {
        this.target = target;
        this.toValues = {};
        this.duration = 1000;
        this.easingFunction = value => value;
        this.startTime = -1;
        this.startValues = {};
        this.onUpdateCallback = null;
        this.onCompleteCallback = null;
    }

    to(values, duration) {
        this.toValues = values;
        this.duration = duration;
        return this;
    }

    easing(easingFunction) {
        this.easingFunction = easingFunction;
        return this;
    }

    onUpdate(callback) {
        this.onUpdateCallback = callback;
        return this;
    }

    onComplete(callback) {
        this.onCompleteCallback = callback;
        return this;
    }

    start() {
        this.startTime = performance.now();
        this.startValues = {};
        for (const key of Object.keys(this.toValues)) {
            this.startValues[key] = this.target[key];
        }
        TWEEN.add(this);
        return this;
    }

    update(time) {
        if (this.startTime === -1) return true;

        const elapsed = time - this.startTime;
        const progress = Math.min(elapsed / this.duration, 1);
        const eased = this.easingFunction(progress);

        for (const key of Object.keys(this.toValues)) {
            this.target[key] = this.startValues[key]
                + (this.toValues[key] - this.startValues[key]) * eased;
        }

        this.onUpdateCallback?.(eased);
        if (progress === 1) {
            this.onCompleteCallback?.();
            return false;
        }
        return true;
    }
}

export const Easing = {
    Cubic: {
        Out: value => --value * value * value + 1,
        InOut: value => value < 0.5
            ? 4 * value * value * value
            : (value - 1) * (2 * value - 2) * (2 * value - 2) + 1
    }
};
