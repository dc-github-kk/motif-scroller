function initTracer({
                        tracerLengthPx = 150,   // visible tracer length along the path
                        guardBandPx = 50,       // viewport guard band
                        correctionFactor = 0.25,
                        sampling = 40,
                        diagnostics = true,
                        maxHeadStepPx = 80,     //  40, max change in s per frame (smoothing)
                        scrollToPathScale = 1   // how many path px per scroll px
                    } = {}) {

    const svgEl    = document.getElementById("overlay");
    const pathEl   = document.getElementById("deco-path");
    const tracerEl = document.getElementById("tracer");

    if (!svgEl || !pathEl || !tracerEl) {
        console.warn("Missing #overlay, #deco-path, or #tracer");
        return;
    }

    const totalLen   = pathEl.getTotalLength();
    const pathStartY = pathEl.getPointAtLength(0).y;

    // s-state: ghostHeadLen is our smoothed along-path position
    let ghostHeadLen   = 0;   // s (smoothed)
    let visibleHeadLen = 0;   // s used to draw visible segment
    let firstUpdate    = true;

    // track scroll to get per-frame scroll delta
    let prevScrollY = window.scrollY;

    function onScroll() {
        const scrollY    = window.scrollY;
        const scrollDelta = scrollY - prevScrollY;
        prevScrollY      = scrollY;

        const viewTopRaw = scrollY;
        const viewBotRaw = viewTopRaw + window.innerHeight;

        const viewTop = viewTopRaw + guardBandPx;
        const viewBot = viewBotRaw - guardBandPx;

        const result = updateTracerForViewport({
            pathEl,
            tracerEl,
            totalLen,
            pathStartY,
            tracerLengthPx,
            guardBandPx,
            correctionFactor,
            sampling,
            diagnostics,
            maxHeadStepPx,
            scrollToPathScale,
            viewTop,
            viewBot,
            scrollDelta,
            ghostHeadLen,
            visibleHeadLen,
            firstUpdate
        });

        ghostHeadLen   = result.ghostHeadLen;
        visibleHeadLen = result.visibleHeadLen;
        firstUpdate    = false;
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
}

// Updated updateTracerForViewport with lookahead-based dynamic Δs
function updateTracerForViewport({
                                     pathEl,
                                     tracerEl,
                                     totalLen,
                                     pathStartY,
                                     tracerLengthPx,
                                     guardBandPx,       // unused, kept for signature stability
                                     correctionFactor,  // unused, kept for signature stability
                                     sampling,
                                     diagnostics,
                                     maxHeadStepPx,
                                     scrollToPathScale,
                                     viewTop,
                                     viewBot,
                                     scrollDelta,
                                     ghostHeadLen,
                                     visibleHeadLen,
                                     firstUpdate
                                 }) {
    const viewportTop = viewTop;
    const viewportBot = viewBot;

    // 1. Scroll → desired Δs
    // Replace the simple linear mapping with a geometry-aware scaled mapping
    let desiredDeltaS;

    let lookaheadScale;

    if (firstUpdate) {
        // On first update, don't move
        desiredDeltaS = 0;
    } else {
        // Compute a lookahead scale based on local path geometry
        lookaheadScale = computeLookaheadScale({
            pathEl,
            headLen: ghostHeadLen,
            totalLen,
            pathStartY,
            scrollDelta
        });

        desiredDeltaS = scrollDelta * scrollToPathScale * lookaheadScale;

    }

    // 2. Scroll-driven preferred headLen
    let preferredHeadLen = ghostHeadLen + desiredDeltaS;
    preferredHeadLen = Math.max(0, Math.min(totalLen, preferredHeadLen));

    console.debug("dbg:", {
        scrollDelta,
        scrollToPathScale,
        lookaheadScale,
        desiredDeltaS,
        maxHeadStepPx,
        preferredHeadLen
    });

    // 3. Is any part of the path visible?
    const pathVisible = pathHasViewportSegment({
        pathEl,
        totalLen,
        pathStartY,
        viewTop: viewportTop,
        viewBot: viewportBot
    });

    if (!pathVisible) {
        tracerEl.setAttribute("d", "");
        return { ghostHeadLen, visibleHeadLen };
    }

    // 4. Global correction: head must be inside viewport
    const correctedHeadLen = findBestHeadLenInViewport({
        pathEl,
        totalLen,
        pathStartY,
        tracerLengthPx,
        viewportTop,
        viewportBot,
        preferredHeadLen
    });

    // 5. Smooth ghost toward correctedHeadLen
    let deltaS = correctedHeadLen - ghostHeadLen;
    if (Math.abs(deltaS) <= maxHeadStepPx) {
        ghostHeadLen = correctedHeadLen;
    } else {
        ghostHeadLen += (deltaS > 0 ? maxHeadStepPx : -maxHeadStepPx);
    }

    ghostHeadLen = Math.max(0, Math.min(totalLen, ghostHeadLen));

    // 6. Visible segment, head-anchored
    let headLen = ghostHeadLen;
    let tailLen = headLen - tracerLengthPx;

    if (tailLen < 0) {
        tailLen = 0;
        headLen = tracerLengthPx;
    }

    visibleHeadLen = headLen;

    // 7. Draw the tracer
    const segmentLen = visibleHeadLen - tailLen;
    if (segmentLen <= 0) {
        tracerEl.setAttribute("d", "");
        return { ghostHeadLen, visibleHeadLen };
    }

    const step = segmentLen / (sampling - 1);
    const d = [];

    for (let i = 0; i < sampling; i++) {
        const len = tailLen + i * step;
        const p = pathEl.getPointAtLength(len);
        d.push(i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`);
    }

    tracerEl.setAttribute("d", d.join(" "));

    if (diagnostics) {
        const headPt  = pathEl.getPointAtLength(visibleHeadLen);
        const tailPt  = pathEl.getPointAtLength(tailLen);
        const ghostPt = pathEl.getPointAtLength(ghostHeadLen);

        console.log({
            ghostHeadLen,
            ghostHeadY: ghostPt.y,
            visibleHeadLen,
            visibleHeadY: headPt.y,
            tailLen,
            tailY: tailPt.y,
            viewTop: viewportTop,
            viewBot: viewportBot,
            pathVisible
        });
    }

    return { ghostHeadLen, visibleHeadLen };
}

// Pure geometry: does any part of the path fall inside the viewport band?
function pathHasViewportSegment({ pathEl, totalLen, pathStartY, viewTop, viewBot, samples = 40 }) {
    const step = totalLen / (samples - 1);
    for (let i = 0; i < samples; i++) {
        const len = i * step;
        const p = pathEl.getPointAtLength(len);
        // Compare p.y (absolute SVG coordinate) directly to viewport bounds
        if (p.y >= viewTop && p.y <= viewBot) {
            return true;
        }
    }
    return false;
}

// Replaces previous findBestHeadLenInViewport.
// Ensures the tracer segment [tailLen, headLen] fits inside [viewportTop, viewportBot]
// If no sampled headLen fully fits, returns the candidate that minimizes the
// combined violation (distance outside band).
function findBestHeadLenInViewport({
                                       pathEl,
                                       totalLen,
                                       pathStartY,
                                       tracerLengthPx,
                                       viewportTop,
                                       viewportBot,
                                       preferredHeadLen,
                                       samples = 200
                                   }) {
    // helper: compute violation score for a candidate headLen
    // score = 0 if fully fits; otherwise positive penalty (larger = worse)
    function violationScore(headLen) {
        headLen = Math.max(0, Math.min(totalLen, headLen));
        const tailLen = Math.max(0, headLen - tracerLengthPx);
        const headPt = pathEl.getPointAtLength(headLen);
        const tailPt = pathEl.getPointAtLength(tailLen);
        // Use absolute SVG Y coordinates
        const headY = headPt.y;
        const tailY = tailPt.y;

        // head must be <= viewportBot, tail must be >= viewportTop
        let score = 0;
        if (headY > viewportBot) score += headY - viewportBot; // overshoot bottom
        if (tailY < viewportTop) score += viewportTop - tailY; // overshoot top
        // also penalize distance from preferredHeadLen to prefer closeness
        score += Math.abs(headLen - preferredHeadLen) * 0.001; // small tie-breaker
        return { score, headY, tailY, headLen, tailLen };
    }

    // sample uniformly across the path but bias around preferredHeadLen
    // We'll sample a window around preferredHeadLen plus some global samples.
    const candidates = [];
    const windowRadius = Math.min(totalLen, Math.max(tracerLengthPx * 2, totalLen * 0.15));
    const start = Math.max(0, preferredHeadLen - windowRadius);
    const end = Math.min(totalLen, preferredHeadLen + windowRadius);

    // dense samples in the local window
    const localSamples = Math.floor(samples * 0.7);
    for (let i = 0; i < localSamples; i++) {
        const t = i / Math.max(1, localSamples - 1);
        const headLen = start + t * (end - start);
        candidates.push(violationScore(headLen));
    }

    // some global samples to catch edge cases
    const globalSamples = samples - localSamples;
    for (let i = 0; i < globalSamples; i++) {
        const t = i / Math.max(1, globalSamples - 1);
        const headLen = t * totalLen;
        candidates.push(violationScore(headLen));
    }

    // find best candidate (lowest score)
    candidates.sort((a, b) => a.score - b.score);
    const best = candidates[0];

    // If best.score is zero, we have a perfect fit.
    // Otherwise best is the least-bad candidate; return its headLen.
    return best.headLen;
}

function debugTracerState(
    pathEl,
    headLen,
    tailLen,
    pathStartY,
    viewTop,
    viewBot,
    ghostHeadLen,
    targetHeadLen,
    startY,
    endY
) {
    const head   = pathEl.getPointAtLength(headLen);
    const tail   = pathEl.getPointAtLength(tailLen);
    const ghost  = pathEl.getPointAtLength(ghostHeadLen);
    const target = pathEl.getPointAtLength(targetHeadLen);

    console.log({
        startY,
        endY,
        visibleHeadLen: headLen,
        visibleHeadY: head.y,
        tailLen,
        tailY: tail.y,
        ghostHeadLen,
        ghostHeadY: ghost.y,
        targetHeadLen,
        targetHeadY: target.y,
        viewTop,
        viewBot,
        fits:
            tail.y >= viewTop &&
            head.y <= viewBot
    });
}

// New helper: computeLookaheadScale
// Returns a multiplicative scale to apply to scroll->path Δs based on local geometry.
// - pathEl: SVG path element
// - headLen: current along-path head length (s)
// - totalLen: total path length
// - pathStartY: baseline Y used in your code (pathEl.getPointAtLength(0).y)
// - scrollDelta: positive when scrolling down, negative when scrolling up
// computeLookaheadScale with detailed per-frame logging
function computeLookaheadScale({
                                   pathEl,
                                   headLen,
                                   totalLen,
                                   pathStartY,
                                   scrollDelta,
                                   viewportWidth = window.innerWidth,
                                   // tuning parameters
                                   lookaheadViewportFactor = 2.5,   // how many viewports to look ahead
                                   stepPx = 2,                      // arc-length step when marching
                                   verticalThreshold = 30,          // px of Y change considered "meaningful"
                                   minScale = 0.6,
                                   maxScale = 3.0,
                                   diagnostics = true               // enable/disable logging
                               } = {}) {
    // Early exit: no scroll -> neutral scale
    if (!scrollDelta || scrollDelta === 0) {
        if (diagnostics) console.debug("lookahead: no scroll -> scale=1");
        return 1.0;
    }

    const direction = scrollDelta > 0 ? +1 : -1;

    // How far along the path to inspect (arc-length)
    const lookaheadLen = Math.min(totalLen, viewportWidth * lookaheadViewportFactor);

    // March along the path from headLen in the chosen direction
    let accumulated = 0;
    let probeLen = headLen;
    const startPt = pathEl.getPointAtLength(Math.max(0, Math.min(totalLen, headLen)));
    // Use absolute SVG Y coordinate
    const startY = startPt.y;

    // Track extreme Y in the lookahead direction
    let extremeY = startY; // min for downward search, max for upward search
    let foundVerticalChange = 0;

    // Marching loop
    while (accumulated < lookaheadLen) {
        accumulated += stepPx;
        probeLen = headLen + direction * accumulated;

        if (probeLen <= 0) {
            probeLen = 0;
            accumulated = Math.abs(headLen); // reached start
        } else if (probeLen >= totalLen) {
            probeLen = totalLen;
            accumulated = Math.abs(totalLen - headLen); // reached end
        }

        const p = pathEl.getPointAtLength(probeLen);
        // Use absolute SVG Y coordinate
        const probeY = p.y;

        if (direction > 0) {
            // scrolling down -> look for downward movement (larger Y in SVG)
            if (probeY > extremeY) extremeY = probeY;
            foundVerticalChange = extremeY - startY;
            if (foundVerticalChange >= verticalThreshold) break;
        } else {
            // scrolling up -> look for upward movement (smaller Y in SVG)
            if (probeY < extremeY) extremeY = probeY;
            foundVerticalChange = startY - extremeY;
            if (foundVerticalChange >= verticalThreshold) break;
        }

        // If we've hit the ends, stop
        if (probeLen === 0 || probeLen === totalLen) break;
    }

    // Compute vertical opportunity: vertical change per unit arc-length
    const verticalChange = Math.abs(extremeY - startY);
    const arcScanned = Math.max(accumulated, 1); // avoid div by zero
    const verticalOpportunity = verticalChange / arcScanned; // px vertical per path px

    // Map verticalOpportunity to a scale
    let scale;
    if (verticalOpportunity <= 0.05) {
        scale = 2.0;
    } else if (verticalOpportunity <= 0.15) {
        scale = 1.4;
    } else if (verticalOpportunity <= 0.30) {
        scale = 1.0;
    } else {
        const t = Math.min(1, (verticalOpportunity - 0.30) / 0.70); // maps [0.30,1.0+] -> [0,1]
        scale = 1.0 - t * (1.0 - minScale);
    }

    // Clamp for safety
    scale = Math.max(minScale, Math.min(maxScale, scale));

    // Diagnostics logging
    if (diagnostics) {
        console.debug("computeLookaheadScale:", {
            headLen,
            totalLen,
            direction: direction > 0 ? "down" : "up",
            lookaheadLen,
            accumulated,
            probeLen,
            startY,
            extremeY,
            verticalChange,
            arcScanned,
            verticalOpportunity,
            rawScale: scale,
            minScale,
            maxScale
        });
    }

    return scale;
}