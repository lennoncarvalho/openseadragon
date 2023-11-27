/*
 * OpenSeadragon - TileCache
 *
 * Copyright (C) 2009 CodePlex Foundation
 * Copyright (C) 2010-2023 OpenSeadragon contributors
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 * - Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * - Redistributions in binary form must reproduce the above copyright
 *   notice, this list of conditions and the following disclaimer in the
 *   documentation and/or other materials provided with the distribution.
 *
 * - Neither the name of CodePlex Foundation nor the names of its
 *   contributors may be used to endorse or promote products derived from
 *   this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
 * TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 * PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 * LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 * NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

(function( $ ){

/**
 * Cached Data Record, the cache object.
 * Keeps only latest object type required.
 *
 * This class acts like the Maybe type:
 *  - it has 'loaded' flag indicating whether the tile data is ready
 *  - it has 'data' property that has value if loaded=true
 *
 * Furthermore, it has a 'getData' function that returns a promise resolving
 * with the value on the desired type passed to the function.
 *
 * @typedef {{
 *    destroy: function,
 *    revive: function,
 *    save: function,
 *    getDataAs: function,
 *    transformTo: function,
 *    data: ?,
 *    loaded: boolean
 * }} OpenSeadragon.CacheRecord
 */
$.CacheRecord = class {
    constructor() {
       this.revive();
    }

    /**
     * Access the cache record data directly. Preferred way of data access.
     * Might be undefined if this.loaded = false.
     * You can access the data in synchronous way, but the data might not be available.
     * If you want to access the data indirectly (await), use this.transformTo or this.getDataAs
     * @returns {any}
     */
    get data() {
        return this._data;
    }

    /**
     * Read the cache type. The type can dynamically change, but should be consistent at
     * one point in the time. For available types see the OpenSeadragon.Convertor, or the tutorials.
     * @returns {string}
     */
    get type() {
        return this._type;
    }

    /**
     * Await ongoing process so that we get cache ready on callback.
     * @returns {null|*}
     */
    await() {
        if (!this._promise) { //if not cache loaded, do not fail
            return $.Promise.resolve();
        }
        return this._promise;
    }

    getImage() {
        $.console.error("[CacheRecord.getImage] options.image is deprecated. Moreover, it might not work" +
            " correctly as the cache system performs conversion asynchronously in case the type needs to be converted.");
        this.transformTo("image");
        return this.data;
    }

    getRenderedContext() {
        $.console.error("[CacheRecord.getRenderedContext] options.getRenderedContext  is deprecated. Moreover, it might not work" +
            " correctly as the cache system performs conversion asynchronously in case the type needs to be converted.");
        this.transformTo("context2d");
        return this.data;
    }

    /**
     * Set the cache data. Asynchronous.
     * @param {any} data
     * @param {string} type
     * @returns {OpenSeadragon.Promise<?>} the old cache data that has been overwritten
     */
    setDataAs(data, type) {
        //allow set data with destroyed state, destroys the data if necessary
        $.console.assert(data !== undefined, "[CacheRecord.setDataAs] needs valid data to set!");
        if (this._conversionJobQueue) {
            //delay saving if ongiong conversion, these were registered first
            let resolver = null;
            const promise = new $.Promise((resolve, reject) => {
                resolver = resolve;
            });
            this._conversionJobQueue.push(() => resolver(this._overwriteData(data, type)));
            return promise;
        }
        return this._overwriteData(data, type);
    }

    /**
     * Access the cache record data indirectly. Preferred way of data access. Asynchronous.
     * @param {string?} [type=this.type]
     * @param {boolean?} [copy=true] if false and same type is retrieved as the cache type,
     *  copy is not performed: note that this is potentially dangerous as it might
     *  introduce race conditions (you get a cache data direct reference you modify,
     *  but others might also access it, for example drawers to draw the viewport).
     * @returns {OpenSeadragon.Promise<?>} desired data type in promise, undefined if the cache was destroyed
     */
    getDataAs(type = this._type, copy = true) {
        if (this.loaded && type === this._type) {
            return copy ? $.convertor.copy(this._data, type) : this._promise;
        }

        return this._promise.then(data => {
            //might get destroyed in meanwhile
            if (this._destroyed) {
                return undefined;
            }
            if (type !== this._type) {
                return $.convertor.convert(data, this._type, type);
            }
            if (copy) { //convert does not copy data if same type, do explicitly
                return $.convertor.copy(data, type);
            }
            return data;
        });
    }

    /**
     * Transform cache to desired type and get the data after conversion.
     * Does nothing if the type equals to the current type. Asynchronous.
     * @param {string} type
     * @return {OpenSeadragon.Promise<?>|*}
     */
    transformTo(type = this._type) {
        if (!this.loaded || type !== this._type) {
            if (!this.loaded) {
                this._conversionJobQueue = this._conversionJobQueue || [];
                let resolver = null;
                const promise = new $.Promise((resolve, reject) => {
                    resolver = resolve;
                });
                this._conversionJobQueue.push(() => {
                    if (this._destroyed) {
                        return;
                    }
                    if (type !== this._type) {
                        //ensures queue gets executed after finish
                        this._convert(this._type, type);
                        this._promise.then(data => resolver(data));
                    } else {
                        //must ensure manually, but after current promise finished, we won't wait for the following job
                        this._promise.then(data => {
                            this._checkAwaitsConvert();
                            return resolver(data);
                        });
                    }
                });
                return promise;
            }
            this._convert(this._type, type);
        }
        return this._promise;
    }

    /**
     * Set initial state, prepare for usage.
     * Must not be called on active cache, e.g. first call destroy().
     */
    revive() {
        $.console.assert(!this.loaded && !this._type, "[CacheRecord::revive] must not be called when loaded!");
        this._tiles = [];
        this._data = null;
        this._type = null;
        this.loaded = false;
        this._promise = null;
        this._destroyed = false;
    }

    /**
     * Free all the data and call data destructors if defined.
     */
    destroy() {
        delete this._conversionJobQueue;
        this._destroyed = true;

        //make sure this gets destroyed even if loaded=false
        if (this.loaded) {
            $.convertor.destroy(this._data, this._type);
            this._tiles = null;
            this._data = null;
            this._type = null;
            this._promise = null;
        } else {
            const oldType = this._type;
            this._promise.then(x => {
                //ensure old data destroyed
                $.convertor.destroy(x, oldType);
                //might get revived...
                if (!this._destroyed) {
                    return;
                }
                this._tiles = null;
                this._data = null;
                this._type = null;
                this._promise = null;
            });
        }
        this.loaded = false;
    }

    /**
     * Add tile dependency on this record
     * @param tile
     * @param data
     * @param type
     */
    addTile(tile, data, type) {
        if (this._destroyed) {
            return;
        }
        $.console.assert(tile, '[CacheRecord.addTile] tile is required');

        //allow overriding the cache - existing tile or different type
        if (this._tiles.includes(tile)) {
            this.removeTile(tile);

        } else if (!this.loaded) {
            this._type = type;
            this._promise = $.Promise.resolve(data);
            this._data = data;
            this.loaded = true;
        }
        //else pass: the tile data type will silently change as it inherits this cache
        this._tiles.push(tile);
    }

    /**
     * Remove tile dependency on this record.
     * @param tile
     * @returns {Boolean} true if record removed
     */
    removeTile(tile) {
        if (this._destroyed) {
            return false;
        }
        for (let i = 0; i < this._tiles.length; i++) {
            if (this._tiles[i] === tile) {
                this._tiles.splice(i, 1);
                return true;
            }
        }
        $.console.warn('[CacheRecord.removeTile] trying to remove unknown tile', tile);
        return false;
    }

    /**
     * Get the amount of tiles sharing this record.
     * @return {number}
     */
    getTileCount() {
        return this._tiles ? this._tiles.length : 0;
    }

    /**
     * Private conversion that makes sure collided requests are
     * processed eventually
     * @private
     */
    _checkAwaitsConvert() {
        if (!this._conversionJobQueue || this._destroyed) {
            return;
        }
        //let other code finish first
        setTimeout(() => {
            //check again, meanwhile things might've changed
            if (!this._conversionJobQueue || this._destroyed) {
                return;
            }
            const job = this._conversionJobQueue[0];
            this._conversionJobQueue.splice(0, 1);
            if (this._conversionJobQueue.length === 0) {
                delete this._conversionJobQueue;
            }
            job();
        });
    }

    _triggerNeedsDraw() {
        for (let tile of this._tiles) {
            tile.tiledImage._needsDraw = true;
        }
    }

    /**
     * Safely overwrite the cache data and return the old data
     * @private
     */
    _overwriteData(data, type) {
        if (this._destroyed) {
            //we take ownership of the data, destroy
            $.convertor.destroy(data, type);
            return $.Promise.resolve();
        }
        if (this.loaded) {
            $.convertor.destroy(this._data, this._type);
            this._type = type;
            this._data = data;
            this._promise = $.Promise.resolve(data);
            this._triggerNeedsDraw();
            return this._promise;
        }
        return this._promise.then(x => {
            $.convertor.destroy(x, this._type);
            this._type = type;
            this._data = data;
            this._promise = $.Promise.resolve(data);
            this._triggerNeedsDraw();
            return x;
        });
    }

    /**
     * Private conversion that makes sure the cache knows its data is ready
     * @private
     */
    _convert(from, to) {
        const convertor = $.convertor,
            conversionPath = convertor.getConversionPath(from, to);
        if (!conversionPath) {
            $.console.error(`[OpenSeadragon.convertor.convert] Conversion conversion ${from} ---> ${to} cannot be done!`);
            return; //no-op
        }

        const originalData = this._data,
            stepCount = conversionPath.length,
            _this = this,
            convert = (x, i) => {
                if (i >= stepCount) {
                    _this._data = x;
                    _this.loaded = true;
                    _this._checkAwaitsConvert();
                    return $.Promise.resolve(x);
                }
                let edge = conversionPath[i];
                return $.Promise.resolve(edge.transform(x)).then(
                    y => {
                        if (!y) {
                            $.console.error(`[OpenSeadragon.convertor.convert] data mid result falsey value (while converting using %s)`, edge);
                            //try to recover using original data, but it returns inconsistent type (the log be hopefully enough)
                            _this._data = from;
                            _this._type = from;
                            _this.loaded = true;
                            return originalData;
                        }
                        //node.value holds the type string
                        convertor.destroy(x, edge.origin.value);
                        return convert(y, i + 1);
                    }
                );
            };

        this.loaded = false;
        this._data = undefined;
        this._type = to;
        this._promise = convert(originalData, 0);
    }
};

/**
 * @class TileCache
 * @memberof OpenSeadragon
 * @classdesc Stores all the tiles displayed in a {@link OpenSeadragon.Viewer}.
 * You generally won't have to interact with the TileCache directly.
 * @param {Object} options - Configuration for this TileCache.
 * @param {Number} [options.maxImageCacheCount] - See maxImageCacheCount in
 * {@link OpenSeadragon.Options} for details.
 */
$.TileCache = class {
    constructor( options ) {
        options = options || {};

        this._maxCacheItemCount = options.maxImageCacheCount || $.DEFAULT_SETTINGS.maxImageCacheCount;
        this._tilesLoaded = [];
        this._zombiesLoaded = [];
        this._zombiesLoadedCount = 0;
        this._cachesLoaded = [];
        this._cachesLoadedCount = 0;
    }

    /**
     * @returns {Number} The total number of tiles that have been loaded by
     * this TileCache. Note that the tile might be recorded here mutliple times,
     * once for each cache it uses.
     */
    numTilesLoaded() {
        return this._tilesLoaded.length;
    }

    /**
     * @returns {Number} The total number of cached objects (+ zombies)
     */
    numCachesLoaded() {
        return this._zombiesLoadedCount + this._cachesLoadedCount;
    }

    /**
     * Caches the specified tile, removing an old tile if necessary to stay under the
     * maxImageCacheCount specified on construction. Note that if multiple tiles reference
     * the same image, there may be more tiles than maxImageCacheCount; the goal is to keep
     * the number of images below that number. Note, as well, that even the number of images
     * may temporarily surpass that number, but should eventually come back down to the max specified.
     * @private
     * @param {Object} options - Tile info.
     * @param {OpenSeadragon.Tile} options.tile - The tile to cache.
     * @param {?String} [options.cacheKey=undefined] - Cache Key to use. Defaults to options.tile.cacheKey
     * @param {String} options.tile.cacheKey - The unique key used to identify this tile in the cache.
     *   Used if cacheKey not set.
     * @param {Image} options.image - The image of the tile to cache. Deprecated.
     * @param {*} options.data - The data of the tile to cache.
     * @param {string} [options.dataType] - The data type of the tile to cache. Required.
     * @param {Number} [options.cutoff=0] - If adding this tile goes over the cache max count, this
     *   function will release an old tile. The cutoff option specifies a tile level at or below which
     *   tiles will not be released.
     * @returns {OpenSeadragon.CacheRecord} - The cache record the tile was attached to.
     */
    cacheTile( options ) {
        $.console.assert( options, "[TileCache.cacheTile] options is required" );
        const theTile = options.tile;
        $.console.assert( theTile, "[TileCache.cacheTile] options.tile is required" );
        $.console.assert( theTile.cacheKey, "[TileCache.cacheTile] options.tile.cacheKey is required" );

        let cutoff = options.cutoff || 0,
            insertionIndex = this._tilesLoaded.length,
            cacheKey = options.cacheKey || theTile.cacheKey;

        let cacheRecord = this._cachesLoaded[cacheKey] || this._zombiesLoaded[cacheKey];
        if (!cacheRecord) {
            if (options.data === undefined) {
                $.console.error("[TileCache.cacheTile] options.image was renamed to options.data. '.image' attribute " +
                    "has been deprecated and will be removed in the future.");
                options.data = options.image;
            }

            //allow anything but undefined, null, false (other values mean the data was set, for example '0')
            $.console.assert( options.data !== undefined && options.data !== null && options.data !== false,
                "[TileCache.cacheTile] options.data is required to create an CacheRecord" );
            cacheRecord = this._cachesLoaded[cacheKey] = new $.CacheRecord();
            this._cachesLoadedCount++;
        } else if (cacheRecord._destroyed) {
            cacheRecord.revive();
            delete this._zombiesLoaded[cacheKey];
            this._zombiesLoadedCount--;
        }

        if (!options.dataType) {
            $.console.error("[TileCache.cacheTile] options.dataType is newly required. " +
                "For easier use of the cache system, use the tile instance API.");
            options.dataType = $.convertor.guessType(options.data);
        }

        cacheRecord.addTile(theTile, options.data, options.dataType);
        if (cacheKey === theTile.cacheKey) {
            theTile.tiledImage._needsDraw = true;
        }

        // Note that just because we're unloading a tile doesn't necessarily mean
        // we're unloading its cache records. With repeated calls it should sort itself out, though.
        let worstTileIndex = -1;
        if ( this._cachesLoadedCount + this._zombiesLoadedCount > this._maxCacheItemCount ) {
            //prefer zombie deletion, faster, better
            if (this._zombiesLoadedCount > 0) {
                for (let zombie in this._zombiesLoaded) {
                    this._zombiesLoaded[zombie].destroy();
                    delete this._zombiesLoaded[zombie];
                    this._zombiesLoadedCount--;
                    break;
                }
            } else {
                let worstTile = null;
                let prevTile, worstTime, worstLevel, prevTime, prevLevel;

                for ( let i = this._tilesLoaded.length - 1; i >= 0; i-- ) {
                    prevTile = this._tilesLoaded[ i ];

                    if ( prevTile.level <= cutoff || prevTile.beingDrawn ) {
                        continue;
                    } else if ( !worstTile ) {
                        worstTile       = prevTile;
                        worstTileIndex  = i;
                        continue;
                    }

                    prevTime    = prevTile.lastTouchTime;
                    worstTime   = worstTile.lastTouchTime;
                    prevLevel   = prevTile.level;
                    worstLevel  = worstTile.level;

                    if ( prevTime < worstTime ||
                        ( prevTime === worstTime && prevLevel > worstLevel )) {
                        worstTile       = prevTile;
                        worstTileIndex  = i;
                    }
                }

                if ( worstTile && worstTileIndex >= 0 ) {
                    this.unloadTile(worstTile, true);
                    insertionIndex = worstTileIndex;
                }
            }
        }

        if (theTile.getCacheSize() === 0) {
            this._tilesLoaded[ insertionIndex ] = theTile;
        } else if (worstTileIndex >= 0) {
            //tile is already recorded, do not add tile, but remove the tile at insertion index
            this._tilesLoaded.splice(insertionIndex, 1);
        }

        return cacheRecord;
    }

    /**
     * Clears all tiles associated with the specified tiledImage.
     * @param {OpenSeadragon.TiledImage} tiledImage
     */
    clearTilesFor( tiledImage ) {
        $.console.assert(tiledImage, '[TileCache.clearTilesFor] tiledImage is required');
        let tile;

        let cacheOverflows = this._cachesLoadedCount + this._zombiesLoadedCount > this._maxCacheItemCount;
        if (tiledImage._zombieCache && cacheOverflows && this._zombiesLoadedCount > 0) {
            //prefer newer (fresh ;) zombies
            for (let zombie in this._zombiesLoaded) {
                this._zombiesLoaded[zombie].destroy();
                delete this._zombiesLoaded[zombie];
            }
            this._zombiesLoadedCount = 0;
            cacheOverflows = this._cachesLoadedCount > this._maxCacheItemCount;
        }
        for ( let i = this._tilesLoaded.length - 1; i >= 0; i-- ) {
            tile = this._tilesLoaded[ i ];

            if (tile.tiledImage === tiledImage) {
                if (!tile.loaded) {
                    //iterates from the array end, safe to remove
                    this._tilesLoaded.splice( i, 1 );
                } else if ( tile.tiledImage === tiledImage ) {
                    this.unloadTile(tile, !tiledImage._zombieCache || cacheOverflows, i);
                }
            }
        }
    }

    /**
     * Get cache record (might be a unattached record, i.e. a zombie)
     * @param cacheKey
     * @returns {OpenSeadragon.CacheRecord|undefined}
     */
    getCacheRecord(cacheKey) {
        $.console.assert(cacheKey, '[TileCache.getCacheRecord] cacheKey is required');
        return this._cachesLoaded[cacheKey] || this._zombiesLoaded[cacheKey];
    }

    /**
     * Delete cache record for a given til
     * @param {OpenSeadragon.Tile} tile
     * @param {string} key cache key
     * @param {boolean} destroy if true, empty cache is destroyed, else left as a zombie
     * @private
     */
    unloadCacheForTile(tile, key, destroy) {
        const cacheRecord = this._cachesLoaded[key];
        //unload record only if relevant - the tile exists in the record
        if (cacheRecord) {
            if (cacheRecord.removeTile(tile)) {
                if (!cacheRecord.getTileCount()) {
                    if (destroy) {
                        // #1 tile marked as destroyed (e.g. too much cached tiles or not a zombie)
                        cacheRecord.destroy();
                    } else {
                        // #2 Tile is a zombie. Do not delete record, reuse.
                        this._zombiesLoaded[key] = cacheRecord;
                        this._zombiesLoadedCount++;
                    }
                    // Either way clear cache
                    delete this._cachesLoaded[key];
                    this._cachesLoadedCount--;
                }
                return true;
            }
            $.console.error("[TileCache.unloadCacheForTile] System tried to delete tile from cache it " +
                "does not belong to! This could mean a bug in the cache system.");
            return false;
        }
        $.console.warn("[TileCache.unloadCacheForTile] Attempting to delete missing cache!");
        return false;
    }

    /**
     * @param tile tile to unload
     * @param destroy destroy tile cache if the cache tile counts falls to zero
     * @param deleteAtIndex index to remove the tile record at, will not remove from _tiledLoaded if not set
     * @private
     */
    unloadTile(tile, destroy, deleteAtIndex) {
        $.console.assert(tile, '[TileCache.unloadTile] tile is required');

        for (let key in tile._caches) {
            //we are 'ok' to remove tile caches here since we later call destroy on tile, otherwise
            //tile has count of its cache size --> would be inconsistent
            this.unloadCacheForTile(tile, key, destroy);
        }
        //delete also the tile record
        if (deleteAtIndex !== undefined) {
            this._tilesLoaded.splice( deleteAtIndex, 1 );
        }

        const tiledImage = tile.tiledImage;
        tile.unload();

        /**
         * Triggered when a tile has just been unloaded from memory.
         *
         * @event tile-unloaded
         * @memberof OpenSeadragon.Viewer
         * @type {object}
         * @property {OpenSeadragon.TiledImage} tiledImage - The tiled image of the unloaded tile.
         * @property {OpenSeadragon.Tile} tile - The tile which has been unloaded.
         * @property {boolean} destroyed - False if the tile data was kept in the system.
         */
        tiledImage.viewer.raiseEvent("tile-unloaded", {
            tile: tile,
            tiledImage: tiledImage,
            destroyed: destroy
        });
    }
};


}( OpenSeadragon ));
