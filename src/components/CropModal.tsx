import React, { useState, useRef } from 'react';
import ReactCrop, { Crop, centerCrop, makeAspectCrop, convertToPixelCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';

interface CropModalProps {
  imageSrc: string;
  maxDimension?: number;
  onCropComplete: (croppedBase64: string) => void;
  onCancel: () => void;
}

function centerAspectCrop(mediaWidth: number, mediaHeight: number, aspect: number) {
  return centerCrop(
    makeAspectCrop(
      {
        unit: '%',
        width: 90,
      },
      aspect,
      mediaWidth,
      mediaHeight,
    ),
    mediaWidth,
    mediaHeight,
  )
}

export default function CropModal({ imageSrc, maxDimension = 600, onCropComplete, onCancel }: CropModalProps) {
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<Crop>();
  const imgRef = useRef<HTMLImageElement>(null);

  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const { width, height } = e.currentTarget;
    const aspect = 4 / 5;
    const initial = centerAspectCrop(width, height, aspect);
    setCrop(initial);
    // Let "Apply" work without first dragging the crop box
    setCompletedCrop(convertToPixelCrop(initial, width, height));
  }

  const handleComplete = async () => {
    if (!completedCrop || !imgRef.current) return;

    const canvas = document.createElement('canvas');
    const image = imgRef.current;
    
    // Original dimensions scale
    const scaleX = image.naturalWidth / image.width;
    const scaleY = image.naturalHeight / image.height;
    
    canvas.width = completedCrop.width * scaleX;
    canvas.height = completedCrop.height * scaleY;
    const ctx = canvas.getContext('2d');
    
    if (!ctx) return;

    ctx.drawImage(
      image,
      completedCrop.x * scaleX,
      completedCrop.y * scaleY,
      completedCrop.width * scaleX,
      completedCrop.height * scaleY,
      0,
      0,
      completedCrop.width * scaleX,
      completedCrop.height * scaleY
    );

    // Resize to maxDimension (600px for item, 800px for proof) and compress at 0.8 quality
    const targetMax = maxDimension || 600;
    let finalWidth = canvas.width;
    let finalHeight = canvas.height;
    
    if (finalWidth > targetMax || finalHeight > targetMax) {
        const ratio = Math.min(targetMax / finalWidth, targetMax / finalHeight);
        finalWidth = Math.max(1, Math.floor(finalWidth * ratio));
        finalHeight = Math.max(1, Math.floor(finalHeight * ratio));
        
        const scaledCanvas = document.createElement('canvas');
        scaledCanvas.width = finalWidth;
        scaledCanvas.height = finalHeight;
        const scaledCtx = scaledCanvas.getContext('2d');
        if (scaledCtx) {
           scaledCtx.imageSmoothingEnabled = true;
           scaledCtx.imageSmoothingQuality = 'high';
           scaledCtx.drawImage(canvas, 0, 0, finalWidth, finalHeight);
           const base64Image = scaledCanvas.toDataURL('image/jpeg', 0.8);
           onCropComplete(base64Image);
           return;
        }
    }

    const base64Image = canvas.toDataURL('image/jpeg', 0.8);
    onCropComplete(base64Image);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
       {/* Ambient Backing Backdrop */}
       <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xl transition-opacity" onClick={onCancel} />

       <div className="liquid-glass-modal max-w-2xl w-full overflow-hidden p-6 sm:p-8 flex flex-col max-h-[90vh] relative z-10 shadow-2xl">
         <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2 liquid-glass-legible">Crop Image</h2>
         <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">Crop the picture to focus on the key part of the item for optimal visibility inside the rack.</p>
         
         <div className="flex-1 overflow-auto flex items-center justify-center liquid-glass-surface rounded-2xl mb-6 relative min-h-[300px] border border-slate-200/50 dark:border-white/10 p-2">
           <ReactCrop
             crop={crop}
             onChange={(_, percentCrop) => setCrop(percentCrop)}
             onComplete={(c) => setCompletedCrop(c)}
             aspect={4 / 5}
             renderSelectionAddon={() => (
               <div className="absolute inset-0 pointer-events-none overflow-hidden ring-2 ring-rose-500/50">
                 {/* Safe zone */}
                 <div className="absolute top-[25%] bottom-[25%] left-[25%] right-[25%] border-2 border-blue-400 bg-blue-500/10 shadow-[0_0_0_9999px_rgba(225,29,72,0.2)] flex flex-col items-center justify-center">
                   <span className="text-blue-600 dark:text-blue-300 font-bold liquid-glass-surface px-2.5 py-0.5 rounded-lg text-[10px] select-none text-center border border-blue-400/30">
                     Important
                   </span>
                 </div>
                 <div className="absolute bottom-2 inset-x-0 flex justify-center">
                   <span className="text-rose-600 dark:text-rose-300 font-bold liquid-glass-surface px-2.5 py-0.5 rounded-lg text-[10px] select-none text-center border border-rose-400/30">
                     Fades out
                   </span>
                 </div>
               </div>
             )}
           >
             <img
               ref={imgRef}
               alt="Crop me"
               src={imageSrc}
               onLoad={onImageLoad}
               style={{ maxHeight: '50vh', objectFit: 'contain' }}
             />
           </ReactCrop>
         </div>

         <div className="flex justify-end gap-3 pt-2 border-t border-slate-200/50 dark:border-white/10">
            <button
               onClick={onCancel}
               className="liquid-glass-btn-secondary px-5 py-2.5 rounded-xl font-semibold text-sm transition-all"
            >
               Cancel
            </button>
            <button
               onClick={handleComplete}
               className="liquid-glass-btn-blue px-6 py-2.5 rounded-xl font-bold text-sm shadow-lg transition-all"
            >
               Apply Crop
            </button>
         </div>
       </div>
    </div>
  );
}
