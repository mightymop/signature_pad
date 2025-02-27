/**
 * The main idea and some parts of the code (e.g. drawing variable width Bézier curve) are taken from:
 * http://corner.squareup.com/2012/07/smoother-signatures.html
 *
 * Implementation of interpolation using cubic Bézier curves is taken from:
 * https://web.archive.org/web/20160323213433/http://www.benknowscode.com/2012/09/path-interpolation-using-cubic-bezier_9742.html
 *
 * Algorithm for approximated length of a Bézier curve is taken from:
 * http://www.lemoda.net/maths/bezier-length/index.html
 */

import { Bezier } from './bezier';
import { BasicPoint, Point } from './point';
import { SignatureEventTarget } from './signature_event_target';
import { throttle } from './throttle';

declare global {
  interface CSSStyleDeclaration {
    msTouchAction: string | null;
  }
}

export type SignatureEvent = MouseEvent | Touch | PointerEvent;

export interface FromDataOptions {
  clear?: boolean;
}

export interface PointGroupOptions {
  dotSize: number;
  minWidth: number;
  maxWidth: number;
  penColor: string;
}

export interface Options extends Partial<PointGroupOptions> {
  minDistance?: number;
  velocityFilterWeight?: number;
  backgroundColor?: string;
  throttle?: number;
  colorChange?: boolean;
  colorChangeThreeshold?: number;
  widthChange?: boolean;
  widthMultiplier?: number;
}

export interface PointGroup extends PointGroupOptions {
  points: BasicPoint[];
}

export interface IsoSamplePoint {
  PenTipCoord: {
    'cmn:X': number;
    'cmn:Y': number;
    'cmn:Z': number;
  };
  PenTipVelocity: {
    VelocityX: number;
    VelocityY: number;
  };
  DTChannel: number;
  FChannel: number;
}

export interface IsoData {
  '?xml': {
    '@version': string;
    '@encoding': string;
  };
  SignatureSignTimeSeries: {
    '@xmlns': string;
    '@xmlns:cmn': string;
    '@xmlns:xsi': string;
    '@xsi:schemaLocation': string;
    '@cmn:SchemaVersion': string;
    Version: {
      'cmn:Major': number;
      'cmn:Minor': number;
    };
    RepresentationList: {
      Representation: {
        CaptureDateAndTime: string;
        CaptureDevice: {
          DeviceID: {
            'cmn:Organization': number;
            'cmn:Identifier': number;
          };
          DeviceTechnology: string;
        };
        QualityList: {
          'cmn:Quality': {
            'cmn:Algorithm': {
              'cmn:Organization': number;
              'cmn:Identifier': number;
            };
            'cmn:QualityCalculationFailed': null;
          };
        };
        InclusionField: string;
        ChannelDescriptionList: {
          DTChannelDescription: {
            ScalingValue: number;
          };
        };
        SamplePointList: {
          SamplePoint: IsoSamplePoint[];
        };
      };
    };
    VendorSpecificData: {
      'cmn:TypeCode': number;
      'cmn:Data': null;
    };
  };
}

export default class SignaturePad extends SignatureEventTarget {
  // Public stuff
  public dotSize: number;
  public minWidth: number;
  public maxWidth: number;
  public penColor: string;
  public minDistance: number;
  public velocityFilterWeight: number;
  public backgroundColor: string;
  public throttle: number;
  public colorChange: boolean;
  public colorChangeThreeshold: number;
  public widthChange: boolean;
  public widthMultiplier: number;

  // Private stuff
  /* tslint:disable: variable-name */
  private _ctx: CanvasRenderingContext2D;
  private _drawningStroke: boolean;
  private _isEmpty: boolean;
  private _lastPoints: Point[]; // Stores up to 4 most recent points; used to generate a new curve
  private _data: PointGroup[]; // Stores all points in groups (one group per line or dot)
  private _lastVelocity: number;
  private _lastWidth: number;
  private _strokeMoveUpdate: (event: SignatureEvent) => void;
  /* tslint:enable: variable-name */

  private _aktPressure: number;
  private _pointerType: string;

  constructor(private canvas: HTMLCanvasElement, options: Options = {}) {
    super();
    this.velocityFilterWeight = options.velocityFilterWeight || 0.7;
    this.minWidth = options.minWidth || 0.5;
    this.maxWidth = options.maxWidth || 2.5;
    this.throttle = ('throttle' in options ? options.throttle : 16) as number; // in milisecondss
    this.minDistance = (
      'minDistance' in options ? options.minDistance : 5
    ) as number; // in pixels
    this.dotSize = options.dotSize || 0;
    this.penColor = options.penColor || '#000000';
    this.backgroundColor = options.backgroundColor || 'rgba(0,0,0,0)';
    this.colorChange = options.colorChange || true;
    this.colorChangeThreeshold = options.colorChangeThreeshold || 0.1;
    this.widthChange = options.widthChange || true;
    this.widthMultiplier = options.widthMultiplier || 3;

    this._strokeMoveUpdate = this.throttle
      ? throttle(SignaturePad.prototype._strokeUpdate, this.throttle)
      : SignaturePad.prototype._strokeUpdate;
    this._ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

    this.clear();

    // Enable mouse and touch event handlers
    this.on();
  }

  public clear(): void {
    const { _ctx: ctx, canvas } = this;

    // Clear canvas using background color
    ctx.fillStyle = this.backgroundColor;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    this._data = [];
    this._reset();
    this._isEmpty = true;
  }

  public fromDataURL(
    dataUrl: string,
    options: {
      ratio?: number;
      width?: number;
      height?: number;
      xOffset?: number;
      yOffset?: number;
    } = {},
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const ratio = options.ratio || window.devicePixelRatio || 1;
      const width = options.width || this.canvas.width / ratio;
      const height = options.height || this.canvas.height / ratio;
      const xOffset = options.xOffset || 0;
      const yOffset = options.yOffset || 0;

      this._reset();

      image.onload = (): void => {
        this._ctx.drawImage(image, xOffset, yOffset, width, height);
        resolve();
      };
      image.onerror = (error): void => {
        reject(error);
      };
      image.crossOrigin = 'anonymous';
      image.src = dataUrl;

      this._isEmpty = false;
    });
  }

  public toDataURL(type = 'image/png', encoderOptions?: number): string {
    switch (type) {
      case 'image/svg+xml':
        return this._toSVG();
      default:
        return this.canvas.toDataURL(type, encoderOptions);
    }
  }

  public on(): void {
    // Disable panning/zooming when touching canvas element
    this.canvas.style.touchAction = 'none';
    this.canvas.style.msTouchAction = 'none';
    this.canvas.style.userSelect = 'none';

    const isIOS =
      /Macintosh/.test(navigator.userAgent) && 'ontouchstart' in document;

    // The "Scribble" feature of iOS intercepts point events. So that we can lose some of them when tapping rapidly.
    // Use touch events for iOS platforms to prevent it. See https://developer.apple.com/forums/thread/664108 for more information.
    if (window.PointerEvent && !isIOS) {
      this._handlePointerEvents();
    } else {
      this._handleMouseEvents();

      if ('ontouchstart' in window) {
        this._handleTouchEvents();
      }
    }
  }

  public off(): void {
    // Enable panning/zooming when touching canvas element
    this.canvas.style.touchAction = 'auto';
    this.canvas.style.msTouchAction = 'auto';
    this.canvas.style.userSelect = 'auto';

    this.canvas.removeEventListener('pointerdown', this._handlePointerStart);
    this.canvas.removeEventListener('pointermove', this._handlePointerMove);
    document.removeEventListener('pointerup', this._handlePointerEnd);

    this.canvas.removeEventListener('mousedown', this._handleMouseDown);
    this.canvas.removeEventListener('mousemove', this._handleMouseMove);
    document.removeEventListener('mouseup', this._handleMouseUp);

    this.canvas.removeEventListener('touchstart', this._handleTouchStart);
    this.canvas.removeEventListener('touchmove', this._handleTouchMove);
    this.canvas.removeEventListener('touchend', this._handleTouchEnd);
  }

  public isEmpty(): boolean {
    return this._isEmpty;
  }

  public fromData(
    pointGroups: PointGroup[],
    { clear = true }: FromDataOptions = {},
  ): void {
    if (clear) {
      this.clear();
    }

    this._fromData(
      pointGroups,
      this._drawCurve.bind(this),
      this._drawDot.bind(this),
    );

    this._data = clear ? pointGroups : this._data.concat(pointGroups);
  }

  public toData(): PointGroup[] {
    return this._data;
  }

  // Event handlers
  private _handleMouseDown = (event: MouseEvent): void => {
    if (event.buttons === 1) {
      this._drawningStroke = true;
      this._strokeBegin(event);
    }
  };

  private _handleMouseMove = (event: MouseEvent): void => {
    if (this._drawningStroke) {
      this._strokeMoveUpdate(event);
    }
  };

  private _handleMouseUp = (event: MouseEvent): void => {
    if (event.buttons === 1 && this._drawningStroke) {
      this._drawningStroke = false;
      this._strokeEnd(event);
    }
  };

  private _handleTouchStart = (event: TouchEvent): void => {
    // Prevent scrolling.
    event.preventDefault();

    if (event.targetTouches.length === 1) {
      const touch = event.changedTouches[0];
      this._strokeBegin(touch);
    }
  };

  private _handleTouchMove = (event: TouchEvent): void => {
    // Prevent scrolling.
    event.preventDefault();

    const touch = event.targetTouches[0];
    this._strokeMoveUpdate(touch);
  };

  private _handleTouchEnd = (event: TouchEvent): void => {
    const wasCanvasTouched = event.target === this.canvas;
    if (wasCanvasTouched) {
      event.preventDefault();

      const touch = event.changedTouches[0];
      this._strokeEnd(touch);
    }
  };

  private _handlePointerStart = (event: PointerEvent): void => {
    this._drawningStroke = true;
    event.preventDefault();
    this._strokeBegin(event);
  };

  private _handlePointerMove = (event: PointerEvent): void => {
    if (this._drawningStroke) {
      event.preventDefault();
      this._strokeMoveUpdate(event);
    }
  };

  private _handlePointerEnd = (event: PointerEvent): void => {
    if (this._drawningStroke) {
      event.preventDefault();
      this._drawningStroke = false;
      this._strokeEnd(event);
    }
  };

  // Private methods
  private _strokeBegin(event: SignatureEvent): void {
    this.dispatchEvent(new CustomEvent('beginStroke', { detail: event }));

    const newPointGroup: PointGroup = {
      dotSize: this.dotSize,
      minWidth: this.minWidth,
      maxWidth: this.maxWidth,
      penColor: this.penColor,
      points: [],
    };

    this._data.push(newPointGroup);
    this._reset();
    this._strokeUpdate(event);
  }

  private _strokeUpdate(event: SignatureEvent): void {
    if (this._data.length === 0) {
      // This can happen if clear() was called while a signature is still in progress,
      // or if there is a race condition between start/update events.
      this._strokeBegin(event);
      return;
    }

    this.dispatchEvent(
      new CustomEvent('beforeUpdateStroke', { detail: event }),
    );

    const x = event.clientX;
    const y = event.clientY;
    const pressure =
      (event as PointerEvent).pressure !== undefined
        ? (event as PointerEvent).pressure
        : (event as Touch).force !== undefined
        ? (event as Touch).force
        : 0;
    this._aktPressure = pressure;
    this._pointerType = (<any>event).pointerType;

    const point = this._createPoint(x, y, pressure);
    const lastPointGroup = this._data[this._data.length - 1];
    const lastPoints = lastPointGroup.points;
    const lastPoint =
      lastPoints.length > 0 && lastPoints[lastPoints.length - 1];
    const isLastPointTooClose = lastPoint
      ? point.distanceTo(lastPoint) <= this.minDistance
      : false;
    const { penColor, dotSize, minWidth, maxWidth } = lastPointGroup;

    // Skip this point if it's too close to the previous one
    if (!lastPoint || !(lastPoint && isLastPointTooClose)) {
      const curve = this._addPoint(point);

      if (!lastPoint) {
        this._drawDot(point, {
          penColor,
          dotSize,
          minWidth,
          maxWidth,
        });
      } else if (curve) {
        this._drawCurve(curve, {
          penColor,
          dotSize,
          minWidth,
          maxWidth,
        });
      }

      lastPoints.push({
        time: point.time,
        x: point.x,
        y: point.y,
        pressure: point.pressure,
      });
    }

    this.dispatchEvent(new CustomEvent('afterUpdateStroke', { detail: event }));
  }

  private _strokeEnd(event: SignatureEvent): void {
    this._strokeUpdate(event);

    this.dispatchEvent(new CustomEvent('endStroke', { detail: event }));
  }

  private _handlePointerEvents(): void {
    this._drawningStroke = false;

    this.canvas.addEventListener('pointerdown', this._handlePointerStart);
    this.canvas.addEventListener('pointermove', this._handlePointerMove);
    document.addEventListener('pointerup', this._handlePointerEnd);
  }

  private _handleMouseEvents(): void {
    this._drawningStroke = false;

    this.canvas.addEventListener('mousedown', this._handleMouseDown);
    this.canvas.addEventListener('mousemove', this._handleMouseMove);
    document.addEventListener('mouseup', this._handleMouseUp);
  }

  private _handleTouchEvents(): void {
    this.canvas.addEventListener('touchstart', this._handleTouchStart);
    this.canvas.addEventListener('touchmove', this._handleTouchMove);
    this.canvas.addEventListener('touchend', this._handleTouchEnd);
  }

  // Called when a new line is started
  private _reset(): void {
    this._lastPoints = [];
    this._lastVelocity = 0;
    this._lastWidth = (this.minWidth + this.maxWidth) / 2;
    this._ctx.fillStyle = this.getColor(this.penColor, 0);
  }

  private _createPoint(x: number, y: number, pressure: number): Point {
    const rect = this.canvas.getBoundingClientRect();

    return new Point(
      x - rect.left,
      y - rect.top,
      pressure,
      new Date().getTime(),
    );
  }

  // Add point to _lastPoints array and generate a new curve if there are enough points (i.e. 3)
  private _addPoint(point: Point): Bezier | null {
    const { _lastPoints } = this;

    _lastPoints.push(point);

    if (_lastPoints.length > 2) {
      // To reduce the initial lag make it work with 3 points
      // by copying the first point to the beginning.
      if (_lastPoints.length === 3) {
        _lastPoints.unshift(_lastPoints[0]);
      }

      // _points array will always have 4 points here.
      const widths = this._calculateCurveWidths(_lastPoints[1], _lastPoints[2]);
      const curve = Bezier.fromPoints(_lastPoints, widths);

      // Remove the first element from the list, so that there are no more than 4 points at any time.
      _lastPoints.shift();

      return curve;
    }

    return null;
  }

  private _calculateCurveWidths(
    startPoint: Point,
    endPoint: Point,
  ): { start: number; end: number } {
    const velocity =
      this.velocityFilterWeight * endPoint.velocityFrom(startPoint) +
      (1 - this.velocityFilterWeight) * this._lastVelocity;

    let newWidth = this._strokeWidth(velocity);
    if (this.widthChange && this._pointerType === 'pen') {
      newWidth += this._aktPressure * this.widthMultiplier;
    }

    const widths = {
      end: newWidth,
      start: this._lastWidth,
    };

    this._lastVelocity = velocity;
    this._lastWidth = newWidth;

    return widths;
  }

  private _strokeWidth(velocity: number): number {
    return Math.max(this.maxWidth / (velocity + 1), this.minWidth);
  }

  private _drawCurveSegment(x: number, y: number, width: number): void {
    const ctx = this._ctx;

    ctx.moveTo(x, y);
    ctx.arc(x, y, width, 0, 2 * Math.PI, false);
    this._isEmpty = false;
  }

  private _drawCurve(curve: Bezier, options: PointGroupOptions): void {
    const ctx = this._ctx;
    const widthDelta = curve.endWidth - curve.startWidth;
    // '2' is just an arbitrary number here. If only lenght is used, then
    // there are gaps between curve segments :/
    const drawSteps = Math.ceil(curve.length()) * 2;

    ctx.beginPath();
    ctx.fillStyle = this.getColor(options.penColor, this._aktPressure);

    for (let i = 0; i < drawSteps; i += 1) {
      // Calculate the Bezier (x, y) coordinate for this step.
      const t = i / drawSteps;
      const tt = t * t;
      const ttt = tt * t;
      const u = 1 - t;
      const uu = u * u;
      const uuu = uu * u;

      let x = uuu * curve.startPoint.x;
      x += 3 * uu * t * curve.control1.x;
      x += 3 * u * tt * curve.control2.x;
      x += ttt * curve.endPoint.x;

      let y = uuu * curve.startPoint.y;
      y += 3 * uu * t * curve.control1.y;
      y += 3 * u * tt * curve.control2.y;
      y += ttt * curve.endPoint.y;

      let width = Math.min(
        curve.startWidth + ttt * widthDelta,
        options.maxWidth,
      );
      if (this.widthChange && this._pointerType === 'pen') {
        width += this._aktPressure * this.widthMultiplier;
      }
      this._drawCurveSegment(x, y, width);
    }

    ctx.closePath();
    ctx.fill();
  }

  private _drawDot(point: BasicPoint, options: PointGroupOptions): void {
    const ctx = this._ctx;
    let width =
      options.dotSize > 0
        ? options.dotSize
        : (options.minWidth + options.maxWidth) / 2;
    if (this.widthChange && this._pointerType === 'pen') {
      width += this._aktPressure * this.widthMultiplier;
    }

    ctx.beginPath();
    this._drawCurveSegment(point.x, point.y, width);
    ctx.closePath();
    ctx.fillStyle = this.getColor(options.penColor, this._aktPressure);
    ctx.fill();
  }

  private getColor(colorstring: string, pressure: number) {
    if (this.colorChange && this._pointerType === 'pen') {
      let color =
        colorstring != '#000000'
          ? this.ColorLuminance(colorstring, 1 - this.colorChangeThreeshold)
          : '#AAAAAA';

      if (pressure > this.colorChangeThreeshold) {
        color = this.ColorLuminance(color, pressure * -1);
      }

      return color;
    } else {
      return colorstring;
    }
  }

  private ColorLuminance(hex: string, lum: number) {
    // validate hex string
    hex = String(hex).replace(/[^0-9a-f]/gi, '');
    if (hex.length < 6) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    lum = lum || 0;

    // convert to decimal and change luminosity
    let rgb = '#',
      c,
      i;
    for (i = 0; i < 3; i++) {
      c = parseInt(hex.substr(i * 2, 2), 16);
      c = Math.round(Math.min(Math.max(0, c + c * lum), 255)).toString(16);
      rgb += ('00' + c).substr(c.length);
    }

    return rgb;
  }

  private _fromData(
    pointGroups: PointGroup[],
    drawCurve: SignaturePad['_drawCurve'],
    drawDot: SignaturePad['_drawDot'],
  ): void {
    for (const group of pointGroups) {
      const { penColor, dotSize, minWidth, maxWidth, points } = group;

      if (points.length > 1) {
        for (let j = 0; j < points.length; j += 1) {
          const basicPoint = points[j];
          const point = new Point(
            basicPoint.x,
            basicPoint.y,
            basicPoint.pressure,
            basicPoint.time,
          );

          // All points in the group have the same color, so it's enough to set
          // penColor just at the beginning.
          this.penColor = penColor;

          if (j === 0) {
            this._reset();
          }

          const curve = this._addPoint(point);

          if (curve) {
            drawCurve(curve, {
              penColor,
              dotSize,
              minWidth,
              maxWidth,
            });
          }
        }
      } else {
        this._reset();

        drawDot(points[0], {
          penColor,
          dotSize,
          minWidth,
          maxWidth,
        });
      }
    }
  }

  private _toSVG(): string {
    const pointGroups = this._data;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const minX = 0;
    const minY = 0;
    const maxX = this.canvas.width / ratio;
    const maxY = this.canvas.height / ratio;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

    svg.setAttribute('width', this.canvas.width.toString());
    svg.setAttribute('height', this.canvas.height.toString());

    this._fromData(
      pointGroups,

      (curve, { penColor }) => {
        const path = document.createElement('path');

        // Need to check curve for NaN values, these pop up when drawing
        // lines on the canvas that are not continuous. E.g. Sharp corners
        // or stopping mid-stroke and than continuing without lifting mouse.
        /* eslint-disable no-restricted-globals */
        if (
          !isNaN(curve.control1.x) &&
          !isNaN(curve.control1.y) &&
          !isNaN(curve.control2.x) &&
          !isNaN(curve.control2.y)
        ) {
          const attr =
            `M ${curve.startPoint.x.toFixed(3)},${curve.startPoint.y.toFixed(
              3,
            )} ` +
            `C ${curve.control1.x.toFixed(3)},${curve.control1.y.toFixed(3)} ` +
            `${curve.control2.x.toFixed(3)},${curve.control2.y.toFixed(3)} ` +
            `${curve.endPoint.x.toFixed(3)},${curve.endPoint.y.toFixed(3)}`;
          path.setAttribute('d', attr);
          path.setAttribute(
            'stroke-width',
            this.widthChange && this._pointerType === 'pen'
              ? (
                  curve.endWidth *
                  (this.widthMultiplier * 2.25 * curve.endPoint.pressure)
                ).toFixed(3)
              : (curve.endWidth * 2.25).toFixed(3),
          );
          path.setAttribute(
            'stroke',
            this.colorChange && this._pointerType === 'pen'
              ? this.getColor(penColor, curve.endPoint.pressure)
              : penColor,
          );
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke-linecap', 'round');

          svg.appendChild(path);
        }
        /* eslint-enable no-restricted-globals */
      },

      (point, { penColor, dotSize, minWidth, maxWidth }) => {
        const circle = document.createElement('circle');
        let size = dotSize > 0 ? dotSize : (minWidth + maxWidth) / 2;
        size =
          this.widthChange && this._pointerType === 'pen'
            ? size * point.pressure * (this.widthMultiplier * 2.25)
            : size;
        circle.setAttribute('r', size.toString());
        circle.setAttribute('cx', point.x.toString());
        circle.setAttribute('cy', point.y.toString());
        circle.setAttribute(
          'fill',
          this.colorChange && this._pointerType === 'pen'
            ? this.getColor(penColor, point.pressure)
            : penColor,
        );

        svg.appendChild(circle);
      },
    );

    const prefix = 'data:image/svg+xml;base64,';
    const header =
      '<svg' +
      ' xmlns="http://www.w3.org/2000/svg"' +
      ' xmlns:xlink="http://www.w3.org/1999/xlink"' +
      ` viewBox="${minX} ${minY} ${this.canvas.width} ${this.canvas.height}"` +
      ` width="${maxX}"` +
      ` height="${maxY}"` +
      '>';
    let body = svg.innerHTML;

    // IE hack for missing innerHTML property on SVGElement
    if (body === undefined) {
      const dummy = document.createElement('dummy');
      const nodes = svg.childNodes;
      dummy.innerHTML = '';

      // tslint:disable-next-line: prefer-for-of
      for (let i = 0; i < nodes.length; i += 1) {
        dummy.appendChild(nodes[i].cloneNode(true));
      }

      body = dummy.innerHTML;
    }

    const footer = '</svg>';
    const data = header + body + footer;

    return prefix + btoa(data);
  }

  public toISOData(): IsoData | null {
    if (this._isEmpty) {
      return null;
    }
    let previousPoint = this._data[0].points[0];
    const isoData: IsoData = {
      '?xml': {
        '@version': '1.0',
        '@encoding': 'utf-8',
      },
      SignatureSignTimeSeries: {
        '@xmlns': 'http://standards.iso.org/iso-iec/19794/-7/ed-1/amd/1',
        '@xmlns:cmn': 'http://standards.iso.org/iso-iec/19794/-1/ed-2/amd/2',
        '@xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        '@xsi:schemaLocation':
          'https://standards.iso.org/iso-iec/19794/-7/ed-2/amd/1/19794-7_ed2_amd1.xsd',
        '@cmn:SchemaVersion': '1.0',
        Version: {
          'cmn:Major': 2,
          'cmn:Minor': 0,
        },
        RepresentationList: {
          Representation: {
            CaptureDateAndTime: new Date(previousPoint.time).toISOString(),
            CaptureDevice: {
              DeviceID: {
                'cmn:Organization': 259,
                'cmn:Identifier': 1,
              },
              DeviceTechnology: 'Electromagnetic',
            },
            QualityList: {
              'cmn:Quality': {
                'cmn:Algorithm': {
                  'cmn:Organization': 259,
                  'cmn:Identifier': 1,
                },
                'cmn:QualityCalculationFailed': null,
              },
            },
            InclusionField: '6CC0', // X, Y, VX, VY, DT, F
            ChannelDescriptionList: {
              DTChannelDescription: {
                ScalingValue: 1000,
              },
            },
            SamplePointList: {
              SamplePoint: [],
            },
          },
        },
        VendorSpecificData: {
          'cmn:TypeCode': 0,
          'cmn:Data': null,
        },
      },
    };
    const dpi = window.devicePixelRatio;
    let previousIsoPoint = { x: 0, y: 0 };
    let initX = 0;
    let initY = 0;
    for (let i = 0, length = this._data.length; i < length; i++) {
      for (
        let j = 0, innerLength = this._data[i].points.length;
        j < innerLength;
        j++
      ) {
        const point = this._data[i].points[j];
        const isFirstPoint = i === 0 && j === 0;
        if (isFirstPoint) {
          initX = point.x;
          initY = point.y;
        }
        const isoPoint = {
          x: isFirstPoint
            ? 0
            : Math.round(((point.x - initX) * 25.4) / (96 * dpi)),
          y: isFirstPoint
            ? 0
            : Math.round(((initY - point.y) * 25.4) / (96 * dpi)),
          dt: isFirstPoint ? 0 : point.time - previousPoint.time,
          vx: 0,
          vy: 0,
          pressure: Math.round(point.pressure * 65535),
        };
        isoPoint.vx = isFirstPoint
          ? 0
          : Math.round(
              (isoPoint.x - previousIsoPoint.x) / (isoPoint.dt / 1000),
            );
        isoPoint.vy = isFirstPoint
          ? 0
          : Math.round(
              (isoPoint.y - previousIsoPoint.y) / (isoPoint.dt / 1000),
            );
        const samplePoint = {
          PenTipCoord: {
            'cmn:X': isoPoint.x,
            'cmn:Y': isoPoint.y,
            'cmn:Z': 0,
          },
          PenTipVelocity: {
            VelocityX: isoPoint.vx,
            VelocityY: isoPoint.vy,
          },
          DTChannel: isoPoint.dt,
          FChannel: isoPoint.pressure,
        };
        isoData.SignatureSignTimeSeries.RepresentationList.Representation.SamplePointList.SamplePoint.push(
          samplePoint,
        );
        previousPoint = point;
        previousIsoPoint = isoPoint;
      }
    }

    return isoData;
  }
}
