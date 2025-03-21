import {
  collection,
  CollectionReference,
  endAt,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  Query,
  QuerySnapshot,
  startAt
} from "firebase/firestore";
import {combineLatest, Observable, Subject} from 'rxjs';
import {finalize, first, map, shareReplay, takeUntil} from 'rxjs/operators';
import {FeatureCollection, Geometry} from './interfaces';
import {bearing, distance, neighbors, setPrecision, toGeoJSONFeature} from './util';
import {FirePoint} from './client';
import {FirebaseApp} from 'firebase/app';

export type QueryFn = (
  ref: CollectionReference
) => Query;

export interface GeoQueryOptions {
  units?: 'km';
  log?: boolean;
}

const defaultOpts: GeoQueryOptions = {units: 'km', log: false};

export interface HitMetadata {
  bearing: number;
  distance: number;
}

export interface GeoQueryDocument {
  hitMetadata: HitMetadata;
}

export class GeoFireQuery<T = any> {
  private readonly ref: any;
  constructor(
    private app: FirebaseApp,
    private refString?: string
  ) {
    if (typeof refString === 'string') {
      const db = getFirestore(app);
      this.ref = collection(db, refString);

      // this.ref = this.app.firestore().collection(ref);
    } else {
      this.ref = refString;
    }
  }
  // GEO QUERIES
  /**
   * Queries the Firestore collection based on geograpic radius
   * @param  {FirePoint} center the starting point for the query, i.e gfx.point(lat, lng)
   * @param  {number} radius the radius to search from the centerpoint
   * @param  {string} field the document field that contains the FirePoint data
   * @param  {GeoQueryOptions} opts=defaultOpts
   * @returns {Observable<GeoQueryDocument>} sorted by nearest to farthest
   */
  within(
    center: FirePoint,
    radius: number,
    field: string,
    opts?: GeoQueryOptions
  ): Observable<(GeoQueryDocument & T)[]> {
    opts = { ...defaultOpts, ...opts };
    const tick = Date.now();
    const precision = setPrecision(radius);
    const radiusBuffer = radius * 1.02; // buffer for edge distances
    const centerHash = center.geohash.substr(0, precision);
    const area = neighbors(centerHash).concat(centerHash);

    const { latitude: centerLat, longitude: centerLng } = center.geopoint;

    // Used to cancel the individual geohash subscriptions
    const complete = new Subject();

    // Map geohash neighbors to individual queries
    const queries = area.map(hash => {
      const query = this.queryPoint(hash, field);
      return createStream(query).pipe(
        snapToData(),
        takeUntil(complete)
      );
    });

    // Combine all queries concurrently
    return combineLatest(...queries).pipe(
      map(arr => {
        // Combine results into a single array
        const reduced = arr.reduce((acc, cur) => acc.concat(cur));

        // Filter by radius
        const filtered = reduced.filter(val => {
          const {latitude, longitude} = val[field].geopoint;

          return (
            distance([centerLat, centerLng], [latitude, longitude]) <=
            radiusBuffer
          );
        });

        // Optional logging
        if (opts.log) {
          console.group('GeoFireX Query');
          console.log(`🌐 Center ${[centerLat, centerLng]}. Radius ${radius}`);
          console.log(`📍 Hits: ${reduced.length}`);
          console.log(`⌚ Elapsed time: ${Date.now() - tick}ms`);
          console.log(`🟢 Within Radius: ${filtered.length}`);
          console.groupEnd();
        }

        // Map and sort to final output
        return filtered
          .map(val => {
            const {latitude, longitude} = val[field].geopoint;

            const hitMetadata = {
              distance: distance([centerLat, centerLng], [latitude, longitude]),
              bearing: bearing([centerLat, centerLng], [latitude, longitude])
            };
            return {...val, hitMetadata} as (GeoQueryDocument & T);
          })

          .sort((a, b) => a.hitMetadata.distance - b.hitMetadata.distance);
      }),
      shareReplay(1),
      finalize(() => {
        opts.log && console.log('✋ Query complete');
        complete.next(true);
      })
    );
  }

  private queryPoint(geohash: string, field: string): Query {
    const end = geohash + '~';
    return query(this.ref, orderBy(`${field}.geohash`), startAt(geohash), endAt(end));

    /*return (this.ref as CollectionReference)
      .orderBy(`${field}.geohash`)
      .startAt(geohash)
      .endAt(end);*/
  }

  // withinBbox(field: string, bbox: number, opts = defaultOpts) {
  //   return 'not implemented';
  // }

  // findNearest(field: string, radius: number, opts = defaultOpts) {
  //   return 'not implemented';
  // }

  // // Expands radius until hit
  // findFirst() {
  //   return 'not implemented';
  // }
}

function snapToData(id = 'id') {
  return map((querySnapshot: QuerySnapshot) =>
    querySnapshot.docs.map(v => {
      return {
        ...(id ? { [id]: v.id } : null),
        ...v.data()
      };
    })
  );
}

/**
internal, do not use. Converts callback to Observable. 
 */
function createStream(input: Query): Observable<any> {
  return new Observable(observer => {
    const unsubscribe = onSnapshot(
        input,
        val => observer.next(val),
        err => observer.error(err)
    );
    return { unsubscribe };
  });
}
/**
 * RxJS operator that converts a collection to a GeoJSON FeatureCollection
 * @param  {string} field the document field that contains the FirePoint
 * @param  {boolean=false} includeProps
 */
export function toGeoJSON(field: string, includeProps: boolean = false) {
  return map((data: any[]) => {
    return {
      type: 'FeatureCollection',
      features: data.map(v =>
        toGeoJSONFeature(
          [v[field].geopoint.latitude, v[field].geopoint.longitude],
          includeProps ? { ...v } : {}
        )
      )
    } as FeatureCollection<Geometry>;
  }) as any;
}

/**
 * Helper function to convert any query from an RxJS Observable to a Promise
 * Example usage: await get( collection.within(a, b, c) )
 * @param  {Observable<any>} observable
 * @returns {Promise<any>}
 */
export function get(observable: Observable<any>): Promise<any> {
  return observable.pipe(first()).toPromise();
}
