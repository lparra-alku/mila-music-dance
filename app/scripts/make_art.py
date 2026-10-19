"""Genera resources/icon.png y resources/splash.png con el bailarin de la app.
Uso: python3 scripts/make_art.py "MUSIC DANCE"
"""
import sys, math
from PIL import Image, ImageDraw, ImageFilter, ImageFont
TITLE = sys.argv[1] if len(sys.argv) > 1 else 'MUSIC DANCE'
def lerpc(a,b,t): return tuple(int(a[i]+(b[i]-a[i])*t) for i in range(3))
def limb(d,x,y,ang,ln,w0,w1):
    r=math.radians(ang); x1=x+math.cos(r)*ln; y1=y+math.sin(r)*ln; n=max(2,int(ln/3))
    for i in range(n+1):
        t=i/n; w=w0+(w1-w0)*t; cx=x+(x1-x)*t; cy=y+(y1-y)*t; d.ellipse([cx-w,cy-w,cx+w,cy+w],fill=255)
    return x1,y1
def dancer(size,s,cx,hipY):
    m=Image.new('L',(size,size),0); d=ImageDraw.Draw(m); shY=hipY-78*s
    P=dict(lu=-138,lf=-138,ru=-42,rf=-42,lt=128,lc=128,rt=52,rc=52); feet=[]
    for sd,g in (('l',-1),('r',1)):
        kx,ky=limb(d,cx+g*9*s,hipY,P[sd+'t'],50*s,11*s,8.5*s); feet.append(limb(d,kx,ky,P[sd+'c'],50*s,8.5*s,6.5*s))
    d.polygon([(cx-16*s,hipY+4*s),(cx+16*s,hipY+4*s),(cx+24*s,shY),(cx-24*s,shY)],fill=255)
    d.ellipse([cx-24*s,shY-9*s,cx+24*s,shY+9*s],fill=255)
    for sd,g in (('l',-1),('r',1)):
        ex,ey=limb(d,cx+g*22*s,shY+2*s,P[sd+'u'],40*s,8*s,6.5*s); wx,wy=limb(d,ex,ey,P[sd+'f'],38*s,6.5*s,5*s)
        d.ellipse([wx-7*s,wy-7*s,wx+7*s,wy+7*s],fill=255)
    d.rectangle([cx-5*s,shY-14*s,cx+5*s,shY+2*s],fill=255); hy=shY-14*s
    d.ellipse([cx-17*s,hy-41*s,cx+17*s,hy+1*s],fill=255); d.ellipse([cx-18.5*s,hy-43*s,cx+18.5*s,hy-27*s],fill=255)
    d.ellipse([cx-7.5*s,hy-48*s,cx+7.5*s,hy-33*s],fill=255)
    return m,feet,hy
def build(size,scale,hipFrac,text=None):
    img=Image.new('RGB',(size,size)); d=ImageDraw.Draw(img)
    for y in range(size): d.line([(0,y),(size,y)],fill=lerpc((48,22,112),(9,4,20),y/size))
    b=Image.new('RGBA',(size,size),(0,0,0,0)); bd=ImageDraw.Draw(b)
    for i,h in enumerate([(255,79,163),(123,79,255),(79,227,255),(255,212,59)]):
        x=size*(0.16+i*0.23); bd.polygon([(x-size*.02,0),(x+size*.02,0),(x+size*.2,size),(x-size*.2,size)],fill=h+(30,))
    img=Image.alpha_composite(img.convert('RGBA'),b.filter(ImageFilter.GaussianBlur(size*.02)))
    s=size/1024*3.1*scale; cx=size/2; hipY=size*hipFrac; mask,feet,hy=dancer(size,s,cx,hipY)
    g=Image.new('RGBA',(size,size),(0,0,0,0)); g.paste((120,220,255,255),mask=mask.filter(ImageFilter.GaussianBlur(size*.02)))
    img=Image.alpha_composite(img,g).convert('RGB')
    gr=Image.new('RGB',(size,size)); gd=ImageDraw.Draw(gr); top=hy-48*s; bot=hipY+100*s
    for y in range(size):
        t=max(0,min(1,(y-top)/(bot-top)))
        gd.line([(0,y),(size,y)],fill=lerpc((255,79,163),(176,77,255),t/.55) if t<.55 else lerpc((176,77,255),(79,108,255),(t-.55)/.45))
    img.paste(gr,mask=mask); d=ImageDraw.Draw(img)
    for fx,fy in feet: d.ellipse([fx-15*s,fy-8*s,fx+15*s,fy+8*s],fill=(79,227,255))
    d.rounded_rectangle([cx-15*s,hy-30*s,cx+15*s,hy-23*s],radius=3*s,fill=(255,255,255))
    if text:
        try: f=ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',int(size*.048),index=1)
        except Exception: f=ImageFont.load_default()
        w=d.textbbox((0,0),text,font=f)[2]; d.text(((size-w)/2,size*.78),text,font=f,fill=(255,255,255))
    return img
build(1024,0.78,0.545).save('resources/icon.png')
sp=build(2732,0.50,0.46,TITLE); sp.save('resources/splash.png'); sp.save('resources/splash-dark.png')
print('arte generado:', TITLE)
