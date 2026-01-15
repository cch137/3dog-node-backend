import type { Pose } from "./connection";
import type { ObjectProps } from "../workflows/schemas";
import { ProtectedTinyNotifier } from "../../lib/utils/tiny-notifier";
import { generateRandomId } from "../../lib/utils/generate-random-id";

export type EntityOption = {
  /** 允許無人控制時自動取得控制權，預設為 true。 */
  allowedAutoClaim?: boolean;
  /** 當超過此時間後沒有更新發生，將強制釋放物件的控制權，若為 null 則不釋放。預設為不釋放。 */
  forceReleaseMs?: number | null;
};

export enum EntityType {
  Anchor = "anchor",
  ProgrammableObject = "prog-obj",
  GeometryObject = "geom-obj",
}

const CONTROLLER_ENTITY_STATES = Symbol();

export class EntityController {
  readonly id = generateRandomId();
  constructor() {}

  readonly [CONTROLLER_ENTITY_STATES] = new Set<EntityStateBase>();

  claim(entity: EntityStateBase) {
    if (this[CONTROLLER_ENTITY_STATES].has(entity)) return false;
    return entity.claim(this);
  }

  release(entity: EntityStateBase) {
    if (!this[CONTROLLER_ENTITY_STATES].has(entity)) return false;
    return entity.release(this);
  }

  applyPose(entity: EntityStateBase, pose: Pose) {
    if (!this[CONTROLLER_ENTITY_STATES].has(entity)) return false;
    return entity.applyPose(this, pose);
  }
}

export enum EntityStateUpdateEventType {
  Claimned = "claimed",
  Released = "released",
  Pose = "pose",
}

export type EntityStateUpdateEvent =
  | {
      type: EntityStateUpdateEventType.Claimned;
      controller: EntityController;
    }
  | {
      type: EntityStateUpdateEventType.Released;
      controller: EntityController;
    }
  | {
      type: EntityStateUpdateEventType.Pose;
      pose: Pose;
    };

export class EntityStateBase<
  T extends EntityType = EntityType
> extends ProtectedTinyNotifier<EntityStateUpdateEvent> {
  readonly id = generateRandomId();
  readonly allowedAutoClaim: boolean;
  readonly forceReleaseMs: number | null;
  private forceReleaseTimeout: NodeJS.Timeout | null = null;

  constructor(public readonly type: T, option: EntityOption = {}) {
    super();
    this.forceReleaseMs = option.forceReleaseMs ?? null;
    this.allowedAutoClaim = option.allowedAutoClaim ?? true;
  }

  private _lastUpdateAtMs = Date.now();
  get lastUpdateAtMs() {
    return this._lastUpdateAtMs;
  }

  private _controller: EntityController | null = null;
  get controller() {
    return this._controller;
  }

  private _pose: Pose = { pos: [0, 0, 0], rot: [0, 0, 0, 1] };
  get pose() {
    return this._pose;
  }

  private recordUpdate() {
    this._lastUpdateAtMs = Date.now();
  }

  private setForceReleaseTimeout(controller: EntityController) {
    if (this.forceReleaseTimeout !== null) {
      clearTimeout(this.forceReleaseTimeout);
      this.forceReleaseTimeout = null;
    }
    if (this.forceReleaseMs === null) return;
    this.forceReleaseTimeout = setTimeout(() => {
      this.release(controller);
    }, this.forceReleaseMs);
  }

  /** 取得控制權 (Claim Control)，回傳值表示是否成功。 */
  claim(controller: EntityController) {
    if (this._controller !== null) return false;
    this.recordUpdate();
    this._controller = controller;
    this.notify({ type: EntityStateUpdateEventType.Claimned, controller });
    controller[CONTROLLER_ENTITY_STATES].add(this);
    this.setForceReleaseTimeout(controller);
    return true;
  }

  /** 釋放控制權 (Release Control)，回傳值表示是否成功。 */
  release(controller: EntityController) {
    if (this._controller !== controller) return false;
    this.recordUpdate();
    this._controller = null;
    this.notify({ type: EntityStateUpdateEventType.Released, controller });
    controller[CONTROLLER_ENTITY_STATES].delete(this);
    if (this.forceReleaseTimeout !== null) {
      clearTimeout(this.forceReleaseTimeout);
      this.forceReleaseTimeout = null;
    }
    return true;
  }

  /** 更新 pose，回傳值表示是否成功。 */
  applyPose(controller: EntityController, pose: Pose) {
    if (this.controller === null && this.allowedAutoClaim) {
      // 如果物件目前沒有控制者，則 controller 嘗試控制物件
      this.claim(controller);
    }
    if (this._controller !== controller) return false;
    this.recordUpdate();
    this._pose = { pos: [...pose.pos], rot: [...pose.rot] };
    this.notify({ type: EntityStateUpdateEventType.Pose, pose });
    this.setForceReleaseTimeout(controller);
    return true;
  }
}

export class AnchorState extends EntityStateBase<EntityType.Anchor> {
  constructor(option?: EntityOption) {
    super(EntityType.Anchor, option);
  }
}

export type ProgrammableObjectStateOption = { props: ObjectProps; url: string };

// programmable object 這個命名意在它是可以透過 code 去改變形態的。
// 但是目前只能暫存 gltf，並沒有達到它定義的完整功能（缺少修改功能）。
export class ProgrammableObjectState extends EntityStateBase<EntityType.ProgrammableObject> {
  readonly props: ObjectProps;
  readonly url: string;

  constructor(
    { props, url }: ProgrammableObjectStateOption,
    option?: EntityOption
  ) {
    super(EntityType.ProgrammableObject, option);
    this.props = { ...props };
    this.url = url;
  }
}

export class GeometryObjectState extends EntityStateBase<EntityType.GeometryObject> {
  readonly geometry: object;
  constructor(geometry: object, option?: EntityOption) {
    super(EntityType.GeometryObject, option);
    this.geometry = geometry;
  }
}

export type EntityState =
  | AnchorState
  | ProgrammableObjectState
  | GeometryObjectState;
