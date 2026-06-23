import { eventWithTime } from '@rrweb/types';
import { Mirror } from 'rrweb-snapshot';
import { playerConfig } from '@rrweb/replay';
import { playerMetaData } from '@rrweb/types';
import { Replayer } from '@rrweb/replay';
import { SvelteComponent } from 'svelte';

declare const __propDef: {
    props: {
        [x: string]: any;
        width?: number | undefined;
        height?: number | undefined;
        maxScale?: number | undefined;
        events: RRwebPlayerOptions['props']['events'];
        skipInactive?: NonNullable<boolean | undefined> | undefined;
        autoPlay?: NonNullable<boolean | undefined> | undefined;
        speedOption?: number[] | undefined;
        speed?: number | undefined;
        showController?: NonNullable<boolean | undefined> | undefined;
        tags?: Record<string, string> | undefined;
        inactiveColor?: string | undefined;
        getMirror?: (() => Mirror) | undefined;
        triggerResize?: (() => void) | undefined;
        toggleFullscreen?: (() => void) | undefined;
        addEventListener?: ((event: string, handler: (params: unknown) => unknown) => void) | undefined;
        addEvent?: ((event: eventWithTime) => void) | undefined;
        getMetaData?: (() => playerMetaData) | undefined;
        getReplayer?: (() => Replayer) | undefined;
        toggle?: (() => void) | undefined;
        setSpeed?: ((speed: number) => void) | undefined;
        toggleSkipInactive?: (() => void) | undefined;
        play?: (() => void) | undefined;
        pause?: (() => void) | undefined;
        goto?: ((timeOffset: number, play?: boolean | undefined) => void) | undefined;
        playRange?: ((timeOffset: number, endTimeOffset: number, startLooping?: boolean | undefined, afterHook?: (() => void) | undefined) => void) | undefined;
    };
    events: {
        [evt: string]: CustomEvent<any>;
    };
    slots: {};
    exports?: undefined;
    bindings?: undefined;
};

declare class Player extends Player_2 {
    constructor(options: {
        data?: RRwebPlayerOptions['props'];
    } & RRwebPlayerOptions);
}
export { Player }
export default Player;

declare class Player_2 extends SvelteComponent<PlayerProps, PlayerEvents, PlayerSlots> {
    get getMirror(): () => Mirror;
    get triggerResize(): () => void;
    get toggleFullscreen(): () => void;
    get addEventListener(): (event: string, handler: (params: unknown) => unknown) => void;
    get addEvent(): (event: eventWithTime) => void;
    get getMetaData(): () => playerMetaData;
    get getReplayer(): () => Replayer;
    get toggle(): () => void;
    get setSpeed(): (speed: number) => void;
    get toggleSkipInactive(): () => void;
    get play(): () => void;
    get pause(): () => void;
    get goto(): (timeOffset: number, play?: boolean | undefined) => void;
    get playRange(): (timeOffset: number, endTimeOffset: number, startLooping?: boolean | undefined, afterHook?: (() => void) | undefined) => void;
}

declare type PlayerEvents = typeof __propDef.events;

declare type PlayerProps = typeof __propDef.props;

declare type PlayerSlots = typeof __propDef.slots;

declare type RRwebPlayerOptions = {
    target: HTMLElement;
    props: {
        events: eventWithTime[];
        width?: number;
        height?: number;
        maxScale?: number;
        autoPlay?: boolean;
        speed?: number;
        speedOption?: number[];
        showController?: boolean;
        tags?: Record<string, string>;
        inactiveColor?: string;
    } & Partial<playerConfig>;
};

export { }

declare global {
    interface Document {
        mozExitFullscreen: Document['exitFullscreen'];
        webkitExitFullscreen: Document['exitFullscreen'];
        msExitFullscreen: Document['exitFullscreen'];
        webkitIsFullScreen: Document['fullscreen'];
        mozFullScreen: Document['fullscreen'];
        msFullscreenElement: Document['fullscreen'];
    }
    interface HTMLElement {
        mozRequestFullScreen: Element['requestFullscreen'];
        webkitRequestFullscreen: Element['requestFullscreen'];
        msRequestFullscreen: Element['requestFullscreen'];
    }
}

